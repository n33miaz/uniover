using System.Formats.Cbor;
using System.Text.Json;
using Fido2NetLib;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.ConfirmStepUp;

internal sealed record ConfirmStepUpRequest(Guid? ChallengeId, AuthenticatorAssertionRawResponse? Credential);

internal sealed record ConfirmStepUpCommand(
    Guid UserId,
    Guid SessionId,
    Guid ChallengeId,
    AuthenticatorAssertionRawResponse Credential,
    ClientInfo Client);

internal sealed record ConfirmStepUpResponse(string Action, DateTimeOffset ExpiresAt);

internal sealed class ConfirmStepUpHandler(
    IdentityDbContext db,
    WebAuthn webAuthn,
    ChallengeStore challenges,
    LoginAuditWriter audit,
    TimeProvider time,
    IOptions<StepUpOptions> options)
{
    /// <summary>Nulo em qualquer recusa; o motivo exato só vai para a auditoria, nunca para o cliente.</summary>
    public async Task<ConfirmStepUpResponse?> HandleAsync(ConfirmStepUpCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var challenge = await challenges.ConsumeAsync(
            command.ChallengeId, command.UserId, ChallengePurposes.StepUp, cancellationToken);
        if (challenge?.Action is not { } action)
        {
            await FailAsync(command, null, "challenge", cancellationToken);
            return null;
        }

        // Sessão já encerrada (logout ou reuso do refresh) não pode abrir confirmação nova.
        var sessionAlive = await db.RefreshTokens.AnyAsync(
            t => t.FamilyId == command.SessionId && t.UserId == command.UserId && t.RevokedAt == null, cancellationToken);
        if (!sessionAlive)
        {
            await FailAsync(command, action, "session", cancellationToken);
            return null;
        }

        try
        {
            // Só entre as passkeys do próprio usuário: o identificador da credencial sozinho não basta.
            var credentialId = command.Credential.RawId;
            var passkey = await db.Passkeys.SingleOrDefaultAsync(
                p => p.UserId == command.UserId && p.CredentialId == credentialId, cancellationToken);
            if (passkey is null)
            {
                await FailAsync(command, action, "credential", cancellationToken);
                return null;
            }

            var result = await webAuthn.VerifyAssertionAsync(
                command.Credential, AssertionOptions.FromJson(challenge.OptionsJson), passkey, cancellationToken);

            // A biblioteca já recusa contador que não cresce; esta conferência própria fecha o caso mesmo se mudar.
            if (!PasskeyRules.SignCountAdvances(passkey.SignCount, result.SignCount))
            {
                await FailAsync(command, action, "sign-count", cancellationToken);
                return null;
            }

            var now = time.GetUtcNow();
            passkey.RegisterUse(result.SignCount, now);

            // Uma confirmação por (sessão, ação): confirmar de novo renova a validade em vez de empilhar linhas.
            var sessionId = command.SessionId;
            await db.StepUpConfirmations
                .Where(c => c.SessionFamilyId == sessionId && c.Action == action)
                .ExecuteDeleteAsync(cancellationToken);
            await challenges.PurgeExpiredAsync(now, cancellationToken);

            var confirmation = StepUpConfirmation.Create(
                command.UserId, command.SessionId, action, now, options.Value.Validity);
            db.StepUpConfirmations.Add(confirmation);
            audit.Add(command.UserId, AuditEvents.StepUpSucceeded, command.Client, action);
            await db.SaveChangesAsync(cancellationToken);

            return new ConfirmStepUpResponse(action, confirmation.ExpiresAt);
        }
        catch (Exception ex) when (ex is Fido2VerificationException or CborContentException or FormatException
            or ArgumentException or JsonException or InvalidOperationException)
        {
            // Resposta malformada ou assinatura que não confere: mesma recusa, e o desafio já foi gasto.
            db.ChangeTracker.Clear();
            await FailAsync(command, action, ex is Fido2VerificationException ? "verification" : "malformed", cancellationToken);
            return null;
        }
    }

    private async Task FailAsync(ConfirmStepUpCommand command, string? action, string reason, CancellationToken cancellationToken)
    {
        // Código curto escolhido aqui (ação validada na emissão + motivo fixo): nada que o cliente digitou entra na trilha.
        var detail = action is null ? reason : $"{action}|{reason}";
        audit.Add(command.UserId, AuditEvents.StepUpFailed, command.Client, detail);
        await db.SaveChangesAsync(cancellationToken);
    }
}
