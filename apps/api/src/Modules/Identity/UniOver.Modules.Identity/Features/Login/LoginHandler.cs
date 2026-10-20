using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;
using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Features.Login;

internal enum LoginStatus
{
    Succeeded,
    InvalidCredentials,
    Locked,
}

internal sealed record LoginResult(
    LoginStatus Status,
    string? AccessToken = null,
    int ExpiresInSeconds = 0,
    string? RefreshSecret = null,
    TimeSpan RefreshMaxAge = default,
    TimeSpan RetryAfter = default);

internal sealed class LoginHandler(
    IdentityDbContext db,
    PasswordService passwords,
    AccessTokenIssuer tokens,
    LoginAuditWriter audit,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    public async Task<LoginResult> HandleAsync(LoginCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var settings = options.Value;
        var now = time.GetUtcNow();
        var email = EmailRules.Normalize(command.Email);

        var user = await db.Users.SingleOrDefaultAsync(u => u.Email == email, cancellationToken);

        // Em bloqueio nem se confere a senha: assim quem chuta não prolonga o bloqueio e o dono, ao errar, não o piora.
        if (user is not null && user.IsLockedOut(now))
        {
            audit.Add(user.Id, AuditEvents.LoginLocked, command.Client);
            await db.SaveChangesAsync(cancellationToken);
            return new LoginResult(LoginStatus.Locked, RetryAfter: user.RemainingLockout(now));
        }

        // Com e-mail inexistente o hash fictício iguala o tempo de resposta.
        var check = passwords.Verify(user, command.Password);
        if (user is null || check == PasswordCheck.Failed)
        {
            user?.RegisterFailure(now, settings.Lockout);
            audit.Add(user?.Id, AuditEvents.LoginFailed, command.Client);
            await db.SaveChangesAsync(cancellationToken);
            return new LoginResult(LoginStatus.InvalidCredentials);
        }

        // Convidado revogado falha igual a senha errada (a senha já foi conferida, então o tempo não revela nada).
        if (user.IsDisabled)
        {
            audit.Add(user.Id, AuditEvents.LoginFailed, command.Client, "account-disabled");
            await db.SaveChangesAsync(cancellationToken);
            return new LoginResult(LoginStatus.InvalidCredentials);
        }

        user.RegisterSuccess();
        if (check == PasswordCheck.SuccessRehashNeeded)
        {
            user.ReplacePasswordHash(passwords.Hash(command.Password));
        }

        var familyId = IdGenerator.NewId();
        var (secret, hash) = SecretTokens.Generate();
        var expiresAt = settings.Refresh.ExpiryFor(now, now);
        db.RefreshTokens.Add(RefreshToken.Create(
            user.Id, familyId, hash, now, expiresAt, command.Client.Ip, command.Client.UserAgent));

        var access = tokens.Issue(user.Id, familyId, user.Role, UniOverAuth.ApiAudience, settings.AccessLifetime, now);
        audit.Add(user.Id, AuditEvents.LoginSucceeded, command.Client);
        await db.SaveChangesAsync(cancellationToken);

        return new LoginResult(
            LoginStatus.Succeeded,
            access.Value,
            (int)settings.AccessLifetime.TotalSeconds,
            secret,
            expiresAt - now);
    }
}
