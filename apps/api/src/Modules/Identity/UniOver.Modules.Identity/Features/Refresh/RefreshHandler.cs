using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Refresh;

internal sealed record RefreshCommand(string? Secret, ClientInfo Client);

internal sealed record RefreshResponse(string AccessToken, [property: JsonNumberHandling(JsonNumberHandling.Strict)] int ExpiresIn);

internal enum RefreshStatus
{
    Succeeded,

    /// <summary>Token desconhecido, vencido, revogado ou reutilizado: o cliente precisa de um login novo.</summary>
    Unauthenticated,

    /// <summary>O dono pausou a conta: a sessão foi derrubada na pausa e o app mostra só "Acesso pausado".</summary>
    Paused,

    /// <summary>Duas abas giraram o mesmo token juntas; o cliente relê o cookie novo e tenta de novo.</summary>
    Conflict,
}

internal sealed record RefreshResult(
    RefreshStatus Status,
    string? AccessToken = null,
    int ExpiresInSeconds = 0,
    string? RefreshSecret = null,
    TimeSpan RefreshMaxAge = default);

/// <summary>
/// Refresh rotativo. Cada uso gira o token dentro da família; um token já girado que reaparece fora da
/// tolerância revoga a família inteira (alguém guardou uma cópia). Única exceção: o mesmo aparelho, com a prova da chave
/// da família sobre um desafio de uso único, recupera UMA vez o token girado cuja resposta se perdeu (ADR 0015).
/// </summary>
internal sealed class RefreshHandler(
    IdentityDbContext db,
    AccessTokenIssuer tokens,
    LoginAuditWriter audit,
    RefreshRecoveryService recovery,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    public async Task<RefreshResult> HandleAsync(RefreshCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var settings = options.Value;
        var policy = settings.Refresh;

        var hash = SecretTokens.Hash(command.Secret);
        if (hash is null)
        {
            return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        var token = await db.RefreshTokens.SingleOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);
        if (token is null)
        {
            return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var familyId = token.FamilyId;

        // Toda rotação e revogação da família (inclusive o "Sair") passa pela mesma trava transacional. Sem ela, o replay
        // pode atualizar os tokens existentes enquanto uma rotação ainda está para inserir o sucessor, deixando esse
        // sucessor ativo.
        await FamilyLock.AcquireAsync(db, familyId, cancellationToken);
        await db.Entry(token).ReloadAsync(cancellationToken);
        if (db.Entry(token).State == EntityState.Detached)
        {
            return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        var now = time.GetUtcNow();

        // Sessão derrubada pela pausa: não é reuso de token (nada vazou), então não revoga a família nem grava alerta de
        // segurança. Com a pausa em vigor o app mostra o aviso; depois de retomada, só pede um login novo.
        if (token.RevokedReason == RevokeReasons.GuestPaused)
        {
            var paused = await db.Users.AnyAsync(u => u.Id == token.UserId && u.PausedAt != null, cancellationToken);
            return new RefreshResult(paused ? RefreshStatus.Paused : RefreshStatus.Unauthenticated);
        }

        // O token que o cliente apresentou; numa recuperação é o antigo, e `token` passa a ser o sucessor que ele nunca recebeu.
        var presented = token;
        var recovered = false;
        switch (token.Evaluate(now, policy.ReuseGrace))
        {
            case RefreshDecision.Reuse:
                var candidate = await recovery.CheckAsync(token, now, policy, cancellationToken);
                var denial = candidate.Denial;
                if (denial is null)
                {
                    denial = await recovery.ConsumeAndVerifyAsync(token, candidate.Key!, command.Client, now, cancellationToken);
                }

                if (denial is not null)
                {
                    await recovery.RevokeFamilyForReuseAsync(token, now, command.Client, denial, cancellationToken);
                    await transaction.CommitAsync(cancellationToken);
                    return new RefreshResult(RefreshStatus.Unauthenticated);
                }

                token = candidate.Successor!;
                recovered = true;
                break;
            case RefreshDecision.Conflict:
                return new RefreshResult(RefreshStatus.Conflict);
            case RefreshDecision.Expired:
                return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        // O papel entra no JWT novo e a conta revogada não renova: o dono troca de papel ou revoga sem esperar o refresh vencer.
        var userId = token.UserId;
        var account = await db.Users
            .Where(u => u.Id == userId)
            .Select(u => new { u.Role, u.DisabledAt, u.PausedAt })
            .SingleOrDefaultAsync(cancellationToken);
        if (account is null || account.DisabledAt is not null || account.PausedAt is not null)
        {
            return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        // O teto absoluto sai da data do primeiro token da família: não há coluna própria para ele.
        var familyStartedAt = await db.RefreshTokens
            .Where(t => t.FamilyId == token.FamilyId)
            .MinAsync(t => t.CreatedAt, cancellationToken);
        if (policy.FamilyExpired(now, familyStartedAt))
        {
            return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        var (secret, newHash) = SecretTokens.Generate();
        var expiresAt = policy.ExpiryFor(now, familyStartedAt);
        var next = RefreshToken.Create(
            token.UserId, token.FamilyId, newHash, now, expiresAt, command.Client.Ip, command.Client.UserAgent);

        // O UPDATE condicional é o que garante UM vencedor quando duas requisições giram o mesmo token ao
        // mesmo tempo: só quem encontra used_at e revoked_at vazios consegue marcar.
        var tokenId = token.Id;
        var claimed = await db.RefreshTokens
            .Where(t => t.Id == tokenId && t.UsedAt == null && t.RevokedAt == null)
            .ExecuteUpdateAsync(
                s => s.SetProperty(t => t.UsedAt, now)
                    .SetProperty(t => t.ReplacedById, next.Id)
                    .SetProperty(t => t.RecoveredAt, recovered ? now : (DateTimeOffset?)null),
                cancellationToken);
        if (claimed != 1)
        {
            return new RefreshResult(RefreshStatus.Conflict);
        }

        db.RefreshTokens.Add(next);
        if (recovered)
        {
            // O token apresentado gastou a única recuperação dele; o sucessor consumido acima também (sem cadeia).
            var presentedId = presented.Id;
            await db.RefreshTokens
                .Where(t => t.Id == presentedId)
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.RecoveredAt, now), cancellationToken);
            audit.Add(
                token.UserId, AuditEvents.RefreshRecovered, command.Client,
                string.Create(System.Globalization.CultureInfo.InvariantCulture, $"after-{(int)(now - presented.UsedAt!.Value).TotalSeconds}s"));
        }
        else
        {
            audit.Add(token.UserId, AuditEvents.RefreshSucceeded, command.Client);
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        var access = tokens.Issue(token.UserId, token.FamilyId, account.Role, UniOverAuth.ApiAudience, settings.AccessLifetime, now);
        return new RefreshResult(
            RefreshStatus.Succeeded,
            access.Value,
            (int)settings.AccessLifetime.TotalSeconds,
            secret,
            expiresAt - now);
    }
}
