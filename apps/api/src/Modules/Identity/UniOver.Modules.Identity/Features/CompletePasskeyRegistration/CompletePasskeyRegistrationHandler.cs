using System.Formats.Cbor;
using System.Text.Json;
using Fido2NetLib;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.ListPasskeys;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.CompletePasskeyRegistration;

internal sealed record CompletePasskeyRegistrationRequest(
    Guid? ChallengeId, string? Name, AuthenticatorAttestationRawResponse? Credential);

internal sealed record CompletePasskeyRegistrationCommand(
    Guid UserId,
    Guid ChallengeId,
    string Name,
    AuthenticatorAttestationRawResponse Credential,
    ClientInfo Client);

internal sealed class CompletePasskeyRegistrationHandler(
    IdentityDbContext db,
    WebAuthn webAuthn,
    ChallengeStore challenges,
    LoginAuditWriter audit,
    TimeProvider time)
{
    // Só estes formatos de atestação são aceitos: a atestação direta não é pedida e o resto não agrega nada ao app.
    private static readonly string[] AcceptedFormats = ["none", "packed"];

    /// <summary>Nulo quando o desafio é inválido ou a atestação não confere (a borda devolve um erro único).</summary>
    public async Task<PasskeySummary?> HandleAsync(
        CompletePasskeyRegistrationCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var challenge = await challenges.ConsumeAsync(
            command.ChallengeId, command.UserId, ChallengePurposes.Register, cancellationToken);
        if (challenge is null)
        {
            return null;
        }

        try
        {
            var options = CredentialCreateOptions.FromJson(challenge.OptionsJson);
            var registered = await webAuthn.VerifyRegistrationAsync(
                command.Credential,
                options,
                async (credentialId, ct) => !await db.Passkeys.AnyAsync(p => p.CredentialId == credentialId, ct),
                cancellationToken);

            if (!AcceptedFormats.Contains(registered.AttestationFormat, StringComparer.Ordinal))
            {
                return null;
            }

            var transports = registered.Transports is { Length: > 0 }
                ? string.Join(',', registered.Transports.Select(t => t.ToString().ToLowerInvariant()))
                : null;
            var passkey = Passkey.Create(
                command.UserId,
                registered.Id,
                registered.PublicKey,
                registered.SignCount,
                registered.AaGuid,
                command.Name,
                transports,
                time.GetUtcNow());

            db.Passkeys.Add(passkey);
            audit.Add(command.UserId, AuditEvents.PasskeyRegistered, command.Client, passkey.Id.ToString("N"));
            await db.SaveChangesAsync(cancellationToken);

            return new PasskeySummary(passkey.Id, passkey.Name, passkey.CreatedAt, passkey.LastUsedAt);
        }
        catch (Exception ex) when (ex is Fido2VerificationException or CborContentException or FormatException
            or ArgumentException or JsonException or InvalidOperationException or DbUpdateException)
        {
            // Qualquer resposta malformada vira a mesma recusa: o cliente não aprende nada sobre onde falhou.
            return null;
        }
    }
}
