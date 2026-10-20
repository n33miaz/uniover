using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.RevokeGuestInvite;

internal enum RevokeGuestInviteStatus
{
    Revoked,
    NotFound,

    /// <summary>Já virou conta: o que se revoga, então, é a conta do convidado.</summary>
    AlreadyUsed,
}

internal sealed class RevokeGuestInviteHandler(IdentityDbContext db, LoginAuditWriter audit, TimeProvider time)
{
    public async Task<RevokeGuestInviteStatus> HandleAsync(
        Guid ownerId, Guid inviteId, ClientInfo client, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);

        var now = time.GetUtcNow();

        // O UPDATE condicional não pisa num aceite que acontece ao mesmo tempo: só revoga o que ainda não foi usado.
        var changed = await db.GuestInvites
            .Where(i => i.Id == inviteId && i.UsedAt == null && i.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.RevokedAt, now), cancellationToken);
        if (changed == 1)
        {
            audit.Add(ownerId, AuditEvents.GuestInviteRevoked, client, inviteId.ToString("N"));
            await db.SaveChangesAsync(cancellationToken);
            return RevokeGuestInviteStatus.Revoked;
        }

        var invite = await db.GuestInvites.AsNoTracking().SingleOrDefaultAsync(i => i.Id == inviteId, cancellationToken);
        return invite switch
        {
            null => RevokeGuestInviteStatus.NotFound,
            { UsedAt: not null } => RevokeGuestInviteStatus.AlreadyUsed,

            // Já revogado antes: repetir o pedido não é erro.
            _ => RevokeGuestInviteStatus.Revoked,
        };
    }
}

internal static class RevokeGuestInviteEndpoint
{
    public static void MapRevokeGuestInvite(this IEndpointRouteBuilder group) =>
        group.MapPost("/guest-invites/{id:guid}/revoke", HandleAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

    private static async Task<IResult> HandleAsync(
        Guid id, HttpContext http, ICurrentUser current, RevokeGuestInviteHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        return await handler.HandleAsync(userId, id, ClientInfo.From(http), cancellationToken) switch
        {
            RevokeGuestInviteStatus.Revoked => TypedResults.NoContent(),
            RevokeGuestInviteStatus.AlreadyUsed => IdentityProblems.InviteNotPending(),
            _ => TypedResults.NotFound(),
        };
    }
}
