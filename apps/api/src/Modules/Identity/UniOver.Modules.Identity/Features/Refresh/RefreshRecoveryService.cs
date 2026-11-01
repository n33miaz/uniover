using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Refresh;

/// <summary>Motivos que ficam no detalhe da auditoria quando um refresh já girado é recusado (e a família revogada).</summary>
internal static class RecoveryDenials
{
    /// <summary>O token foi revogado antes (sair, revogação, reuso anterior).</summary>
    public const string Revoked = "revoked";

    /// <summary>Girado há mais tempo que a janela de recuperação (ou a recuperação está desligada).</summary>
    public const string Window = "window";

    /// <summary>Este token (ou o sucessor que a recuperação consumiu) já participou de uma recuperação: sem cadeia.</summary>
    public const string Chained = "chained";

    /// <summary>Reapresentado sem desafio e prova.</summary>
    public const string NoProof = "no-proof";

    /// <summary>A família não tem chave do aparelho (sessão aberta sem ela ou antes desta regra).</summary>
    public const string NoKey = "no-key";

    /// <summary>O sucessor já foi usado, revogado ou venceu: alguém além do aparelho andou com a sessão.</summary>
    public const string SuccessorUsed = "successor-used";

    /// <summary>Desafio desconhecido, de outra família ou de outro token, ou com nonce errado.</summary>
    public const string ChallengeInvalid = "challenge-invalid";

    /// <summary>Desafio já consumido ou vencido.</summary>
    public const string ChallengeReplayed = "challenge-replayed";

    /// <summary>A assinatura não confere com a chave da família.</summary>
    public const string BadSignature = "bad-signature";
}

/// <summary>Resultado das condições que não dependem da prova: o sucessor e a chave, ou o motivo da recusa.</summary>
internal sealed record RecoveryCandidate(RefreshToken? Successor, RefreshDeviceKey? Key, string? Denial);

/// <summary>
/// Regras comuns do refresh já girado: o que pode ser recuperado, o desafio de uso único, a prova e a revogação por
/// reuso. Tudo roda sob a trava da família e dentro da transação de quem chama.
/// </summary>
internal sealed class RefreshRecoveryService(IdentityDbContext db, LoginAuditWriter audit)
{
    /// <summary>
    /// Um token que já girou pode ser recuperado se, nesta ordem: foi girado há pouco, nunca participou de uma
    /// recuperação, a família tem chave do aparelho e o sucessor continua sem uso (ninguém andou com a sessão).
    /// </summary>
    public async Task<RecoveryCandidate> CheckAsync(
        RefreshToken token, DateTimeOffset now, RefreshPolicy policy, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(token);
        ArgumentNullException.ThrowIfNull(policy);

        var denial = token.Eligibility(now, policy.RecoveryWindow) switch
        {
            RecoveryEligibility.NotRotated => RecoveryDenials.Revoked,
            RecoveryEligibility.OutsideWindow => RecoveryDenials.Window,
            RecoveryEligibility.AlreadyRecovered => RecoveryDenials.Chained,
            _ => null,
        };
        if (denial is not null)
        {
            return new RecoveryCandidate(null, null, denial);
        }

        var familyId = token.FamilyId;
        var key = await db.RefreshDeviceKeys.AsNoTracking().SingleOrDefaultAsync(k => k.FamilyId == familyId, cancellationToken);
        if (key is null)
        {
            return new RecoveryCandidate(null, null, RecoveryDenials.NoKey);
        }

        var successorId = token.ReplacedById;
        var successor = await db.RefreshTokens.SingleOrDefaultAsync(t => t.Id == successorId, cancellationToken);
        if (successor is null
            || successor.FamilyId != familyId
            || successor.UsedAt is not null
            || successor.RevokedAt is not null
            || successor.RecoveredAt is not null
            || successor.ExpiresAt <= now)
        {
            return new RecoveryCandidate(null, key, RecoveryDenials.SuccessorUsed);
        }

        return new RecoveryCandidate(successor, key, null);
    }

    /// <summary>
    /// Emite o desafio de uso único para o token (e apaga os anteriores da família: só o último vale). Devolve o valor
    /// que o cliente assina, <c>id.nonce</c>.
    /// </summary>
    public async Task<string> IssueChallengeAsync(
        RefreshToken token, DateTimeOffset now, RefreshPolicy policy, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(token);
        ArgumentNullException.ThrowIfNull(policy);

        var familyId = token.FamilyId;
        var staleBefore = now - TimeSpan.FromDays(1);
        await db.RefreshRecoveryChallenges
            .Where(c => c.FamilyId == familyId || c.ExpiresAt < staleBefore)
            .ExecuteDeleteAsync(cancellationToken);

        var (nonce, hash) = DeviceProof.NewNonce();
        var challenge = RefreshRecoveryChallenge.Create(familyId, token.Id, hash, now, policy.ChallengeLifetime);
        db.RefreshRecoveryChallenges.Add(challenge);
        await db.SaveChangesAsync(cancellationToken);
        return DeviceProof.FormatChallenge(challenge.Id, nonce);
    }

    /// <summary>
    /// Consome o desafio apresentado (um UPDATE condicional: vale uma vez) e confere a assinatura. Devolve o motivo da
    /// recusa, ou <c>null</c> se a prova vale. O desafio é consumido antes de a assinatura ser conferida: errar custa o
    /// desafio, e quem erra tem a família revogada.
    /// </summary>
    public async Task<string?> ConsumeAndVerifyAsync(
        RefreshToken token, RefreshDeviceKey key, ClientInfo client, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(token);
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(client);

        if (DeviceProof.ParseChallenge(client.RecoveryChallenge) is not { } presented || string.IsNullOrWhiteSpace(client.RecoveryProof))
        {
            return RecoveryDenials.NoProof;
        }

        var challenge = await db.RefreshRecoveryChallenges.AsNoTracking()
            .SingleOrDefaultAsync(c => c.Id == presented.Id, cancellationToken);
        if (challenge is null
            || challenge.FamilyId != token.FamilyId
            || challenge.TokenId != token.Id
            || !CryptographicOperations.FixedTimeEquals(challenge.NonceHash, presented.NonceHash))
        {
            return RecoveryDenials.ChallengeInvalid;
        }

        var challengeId = challenge.Id;
        var consumed = await db.RefreshRecoveryChallenges
            .Where(c => c.Id == challengeId && c.ConsumedAt == null && c.ExpiresAt > now)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.ConsumedAt, now), cancellationToken);
        if (consumed != 1)
        {
            return RecoveryDenials.ChallengeReplayed;
        }

        var message = DeviceProof.Message(token.FamilyId, challenge.Id, presented.Nonce);
        return DeviceProof.Verify(key.PublicKey, message, client.RecoveryProof) ? null : RecoveryDenials.BadSignature;
    }

    /// <summary>
    /// Reuso sem recuperação válida: revoga a família inteira (e as confirmações dela) e audita com o motivo. Quem
    /// apresentou o token não está autenticado: o ator fica nulo e a conta do token é o alvo.
    /// </summary>
    public async Task RevokeFamilyForReuseAsync(
        RefreshToken token, DateTimeOffset now, ClientInfo client, string reason, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(token);
        ArgumentNullException.ThrowIfNull(client);

        var familyId = token.FamilyId;
        await db.RefreshTokens
            .Where(t => t.FamilyId == familyId && t.RevokedAt == null)
            .ExecuteUpdateAsync(
                s => s.SetProperty(t => t.RevokedAt, now).SetProperty(t => t.RevokedReason, RevokeReasons.Reuse),
                cancellationToken);

        // Sessão possivelmente roubada: nenhuma confirmação dela continua valendo.
        await db.StepUpConfirmations
            .Where(c => c.SessionFamilyId == familyId)
            .ExecuteDeleteAsync(cancellationToken);

        audit.Add(null, AuditEvents.RefreshReuseDetected, client, AuditAboutAccount.Detail(token.UserId, reason));
        await db.SaveChangesAsync(cancellationToken);
    }
}
