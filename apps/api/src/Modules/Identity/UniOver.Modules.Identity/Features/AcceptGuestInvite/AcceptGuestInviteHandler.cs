using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;
using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Features.AcceptGuestInvite;

internal sealed record AcceptGuestInviteRequest(string? Token, string? Email, string? Password);

internal sealed record AcceptGuestInviteCommand(string Token, string Email, string Password, ClientInfo Client);

internal enum AcceptGuestInviteStatus
{
    Succeeded,

    /// <summary>Desconhecido, vencido, usado ou revogado: o cliente não fica sabendo qual.</summary>
    InvalidInvite,

    /// <summary>O e-mail já é de outra conta; o convite continua valendo para uma nova tentativa.</summary>
    EmailUnavailable,
}

internal sealed record AcceptGuestInviteResult(
    AcceptGuestInviteStatus Status,
    string? AccessToken = null,
    int ExpiresInSeconds = 0,
    string? RefreshSecret = null,
    TimeSpan RefreshMaxAge = default);

/// <summary>
/// Aceita um convite: quem recebeu o link define o e-mail e a própria senha (o dono nunca a conhece) e já sai com a
/// sessão aberta, como num login. Uso único garantido pelo banco: o convite é reivindicado por um UPDATE condicional
/// dentro da mesma transação que cria a conta, então dois aceites ao mesmo tempo geram uma conta só.
/// </summary>
internal sealed class AcceptGuestInviteHandler(
    IdentityDbContext db,
    PasswordService passwords,
    AccessTokenIssuer tokens,
    LoginAuditWriter audit,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    public async Task<AcceptGuestInviteResult> HandleAsync(AcceptGuestInviteCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var settings = options.Value;
        var now = time.GetUtcNow();

        // O convite é conferido ANTES do hash da senha (caro): quem chuta segredos não faz o servidor gastar CPU de PBKDF2.
        var tokenHash = SecretTokens.Hash(command.Token);
        if (tokenHash is null)
        {
            return new AcceptGuestInviteResult(AcceptGuestInviteStatus.InvalidInvite);
        }

        var invite = await db.GuestInvites.AsNoTracking().SingleOrDefaultAsync(i => i.TokenHash == tokenHash, cancellationToken);
        if (invite is null || invite.StatusAt(now) != InviteStatus.Pending)
        {
            return new AcceptGuestInviteResult(AcceptGuestInviteStatus.InvalidInvite);
        }

        var passwordHash = passwords.Hash(command.Password);

        var user = User.CreateGuest(command.Email, invite.Label, passwordHash, now);

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        // Quem encontra o convite ainda livre o reivindica; o outro, ao reavaliar a condição, encontra zero linhas.
        var inviteId = invite.Id;
        var claimed = await db.GuestInvites
            .Where(i => i.Id == inviteId && i.UsedAt == null && i.RevokedAt == null && i.ExpiresAt > now)
            .ExecuteUpdateAsync(
                s => s.SetProperty(i => i.UsedAt, now).SetProperty(i => i.UsedBy, user.Id),
                cancellationToken);
        if (claimed != 1)
        {
            return new AcceptGuestInviteResult(AcceptGuestInviteStatus.InvalidInvite);
        }

        // Sem commit nas saídas abaixo: a transação desfaz a reivindicação e o convite segue valendo.
        var email = user.Email;
        if (await db.Users.AnyAsync(u => u.Email == email, cancellationToken))
        {
            return new AcceptGuestInviteResult(AcceptGuestInviteStatus.EmailUnavailable);
        }

        var familyId = IdGenerator.NewId();
        var (secret, hash) = SecretTokens.Generate();
        var expiresAt = settings.Refresh.ExpiryFor(now, now);
        db.Users.Add(user);
        db.RefreshTokens.Add(RefreshToken.Create(
            user.Id, familyId, hash, now, expiresAt, command.Client.Ip, command.Client.UserAgent));
        audit.Add(user.Id, AuditEvents.GuestInviteAccepted, command.Client, inviteId.ToString("N"));
        audit.Add(user.Id, AuditEvents.LoginSucceeded, command.Client);

        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Outro aceite criou a mesma conta entre a conferência e a gravação.
            return new AcceptGuestInviteResult(AcceptGuestInviteStatus.EmailUnavailable);
        }

        await transaction.CommitAsync(cancellationToken);

        var access = tokens.Issue(user.Id, familyId, user.Role, UniOverAuth.ApiAudience, settings.AccessLifetime, now);
        return new AcceptGuestInviteResult(
            AcceptGuestInviteStatus.Succeeded,
            access.Value,
            (int)settings.AccessLifetime.TotalSeconds,
            secret,
            expiresAt - now);
    }
}
