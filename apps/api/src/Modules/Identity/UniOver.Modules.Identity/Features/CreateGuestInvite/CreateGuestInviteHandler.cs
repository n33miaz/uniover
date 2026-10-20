using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.CreateGuestInvite;

internal sealed record CreateGuestInviteRequest(string? DisplayName);

internal sealed record CreateGuestInviteCommand(Guid OwnerId, string DisplayName, ClientInfo Client);

/// <param name="Token">O segredo do link: aparece só aqui, uma vez. O banco guarda apenas o hash dele.</param>
internal sealed record CreateGuestInviteResponse(Guid Id, string DisplayName, string Token, DateTimeOffset ExpiresAt);

internal sealed class CreateGuestInviteHandler(
    IdentityDbContext db,
    LoginAuditWriter audit,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    /// <summary>Nulo quando já há convites pendentes demais.</summary>
    public async Task<CreateGuestInviteResponse?> HandleAsync(CreateGuestInviteCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var settings = options.Value;
        var now = time.GetUtcNow();

        var pending = await db.GuestInvites.CountAsync(
            i => i.UsedAt == null && i.RevokedAt == null && i.ExpiresAt > now, cancellationToken);
        if (pending >= settings.MaxPendingGuestInvites)
        {
            return null;
        }

        var (secret, hash) = SecretTokens.Generate();
        var invite = GuestInvite.Create(command.OwnerId, command.DisplayName, hash, now, settings.GuestInviteLifetime);
        db.GuestInvites.Add(invite);

        // Na auditoria vai só o id do convite: o segredo e o nome do convidado ficam de fora.
        audit.Add(command.OwnerId, AuditEvents.GuestInviteCreated, command.Client, invite.Id.ToString("N"));
        await db.SaveChangesAsync(cancellationToken);

        return new CreateGuestInviteResponse(invite.Id, invite.Label, secret, invite.ExpiresAt);
    }
}
