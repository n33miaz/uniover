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

    /// <summary>Senha certa, mas o dono pausou a conta: o app mostra só "Acesso pausado".</summary>
    Paused,
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

        // Nas tentativas que falham (abaixo) o ator da trilha é NULO: quem chuta a senha não está autenticado e não se sabe
        // quem é; gravar a conta como autora faria o ataque aparecer como "a conta tentou entrar e errou". A conta vai
        // como ALVO (no detalhe) e o IP e o aparelho seguem gravados.

        // Em bloqueio nem se confere a senha: assim quem chuta não prolonga o bloqueio e o dono, ao errar, não o piora.
        if (user is not null && user.IsLockedOut(now))
        {
            audit.Add(null, AuditEvents.LoginLocked, command.Client, AuditAboutAccount.Detail(user.Id));
            await db.SaveChangesAsync(cancellationToken);
            return new LoginResult(LoginStatus.Locked, RetryAfter: user.RemainingLockout(now));
        }

        // Com e-mail inexistente o hash fictício iguala o tempo de resposta.
        var check = passwords.Verify(user, command.Password);
        if (user is null || check == PasswordCheck.Failed)
        {
            user?.RegisterFailure(now, settings.Lockout);
            audit.Add(null, AuditEvents.LoginFailed, command.Client, user is null ? null : AuditAboutAccount.Detail(user.Id));
            await db.SaveChangesAsync(cancellationToken);
            return new LoginResult(LoginStatus.InvalidCredentials);
        }

        // Convidado revogado falha igual a senha errada (a senha já foi conferida, então o tempo não revela nada).
        if (user.IsDisabled)
        {
            audit.Add(null, AuditEvents.LoginFailed, command.Client, AuditAboutAccount.Detail(user.Id, "account-disabled"));
            await db.SaveChangesAsync(cancellationToken);
            return new LoginResult(LoginStatus.InvalidCredentials);
        }

        // Pausado: a senha também já foi conferida, então dizer que a conta está pausada só chega a quem a conhece.
        if (user.IsPaused)
        {
            audit.Add(null, AuditEvents.LoginFailed, command.Client, AuditAboutAccount.Detail(user.Id, "account-paused"));
            await db.SaveChangesAsync(cancellationToken);
            return new LoginResult(LoginStatus.Paused);
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
