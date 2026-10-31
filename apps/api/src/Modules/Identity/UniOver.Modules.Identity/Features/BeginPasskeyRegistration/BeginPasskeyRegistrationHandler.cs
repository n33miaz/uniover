using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.BeginPasskeyRegistration;

internal sealed record BeginPasskeyRegistrationRequest(string? Password);

internal sealed record BeginPasskeyRegistrationCommand(Guid UserId, string Password, ClientInfo Client);

internal sealed record BeginPasskeyRegistrationResponse(Guid ChallengeId, System.Text.Json.JsonElement Options);

internal enum BeginPasskeyRegistrationStatus
{
    Succeeded,
    Unauthenticated,
    InvalidPassword,
    Locked,
}

internal sealed record BeginPasskeyRegistrationResult(
    BeginPasskeyRegistrationStatus Status,
    BeginPasskeyRegistrationResponse? Response = null,
    TimeSpan RetryAfter = default);

/// <summary>
/// Pede a senha de novo antes de abrir o cadastro: uma sessão roubada (por exemplo por XSS) não consegue
/// registrar a passkey do atacante sem saber a senha. Errar a senha aqui conta para o mesmo bloqueio do login,
/// senão este endpoint viraria um caminho para chutar a senha sem custo.
/// </summary>
internal sealed class BeginPasskeyRegistrationHandler(
    IdentityDbContext db,
    PasswordService passwords,
    WebAuthn webAuthn,
    ChallengeStore challenges,
    LoginAuditWriter audit,
    FailedLoginCounter failures,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    public async Task<BeginPasskeyRegistrationResult> HandleAsync(
        BeginPasskeyRegistrationCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = time.GetUtcNow();
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == command.UserId, cancellationToken);
        if (user is null)
        {
            return new BeginPasskeyRegistrationResult(BeginPasskeyRegistrationStatus.Unauthenticated);
        }

        if (user.IsLockedOut(now))
        {
            audit.Add(user.Id, AuditEvents.LoginLocked, command.Client, "passkey-registration");
            await db.SaveChangesAsync(cancellationToken);
            return new BeginPasskeyRegistrationResult(
                BeginPasskeyRegistrationStatus.Locked, RetryAfter: user.RemainingLockout(now));
        }

        if (passwords.Verify(user, command.Password) == PasswordCheck.Failed)
        {
            await failures.RegisterAsync(user.Id, now, options.Value.Lockout, cancellationToken);
            audit.Add(user.Id, AuditEvents.LoginFailed, command.Client, "passkey-registration");
            await db.SaveChangesAsync(cancellationToken);
            return new BeginPasskeyRegistrationResult(BeginPasskeyRegistrationStatus.InvalidPassword);
        }

        var existing = await db.Passkeys.AsNoTracking().Where(p => p.UserId == user.Id).ToListAsync(cancellationToken);
        var created = webAuthn.CreateRegistrationOptions(user, existing);
        var challenge = await challenges.IssueAsync(
            user.Id, ChallengePurposes.Register, null, created.ToJson(), cancellationToken);

        return new BeginPasskeyRegistrationResult(
            BeginPasskeyRegistrationStatus.Succeeded,
            new BeginPasskeyRegistrationResponse(challenge.Id, OptionsJson.Parse(challenge.OptionsJson)));
    }
}
