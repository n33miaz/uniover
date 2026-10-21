using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.RevokeGuest;

internal sealed class RevokeGuestHandler(
    IdentityDbContext db, LoginAuditWriter audit, GuestAccountStatus status, AccessGrantsService grants, TimeProvider time)
{
    /// <summary>
    /// Revoga a conta do convidado e derruba as sessões dele. O JWT de acesso já emitido vale até o prazo curto dele
    /// (10 min); o refresh e o bilhete de stream deixam de sair já. <c>false</c> se não há convidado com esse id.
    /// </summary>
    public async Task<bool> HandleAsync(Guid ownerId, Guid guestId, ClientInfo client, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);

        // O filtro por papel impede revogar o dono por aqui, mesmo com um id certo.
        var guest = await db.Users.SingleOrDefaultAsync(u => u.Id == guestId && u.Role == AccountRoles.Guest, cancellationToken);
        if (guest is null)
        {
            return false;
        }

        var now = time.GetUtcNow();
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        guest.Disable(now);
        await db.SaveChangesAsync(cancellationToken);

        // Repetir a revogação também limpa o que sobrou (uma sessão aberta no meio do caminho): é idempotente.
        await db.RefreshTokens
            .Where(t => t.UserId == guestId && t.RevokedAt == null)
            .ExecuteUpdateAsync(
                s => s.SetProperty(t => t.RevokedAt, now).SetProperty(t => t.RevokedReason, RevokeReasons.GuestRevoked),
                cancellationToken);
        await db.StepUpConfirmations.Where(c => c.UserId == guestId).ExecuteDeleteAsync(cancellationToken);

        audit.Add(ownerId, AuditEvents.GuestRevoked, client, guestId.ToString("N"));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        // Só depois do commit: a TV passa a recusar o convidado nesta instância na mesma hora, e as permissões dele
        // também deixam de valer (o cache de permissões é esquecido; a leitura seguinte vê a conta revogada).
        status.MarkRevoked(guestId);
        grants.Invalidate(guestId);
        return true;
    }
}

internal static class RevokeGuestEndpoint
{
    public static void MapRevokeGuest(this IEndpointRouteBuilder group) =>
        group.MapPost("/guests/{id:guid}/revoke", HandleAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound);

    private static async Task<IResult> HandleAsync(
        Guid id, HttpContext http, ICurrentUser current, RevokeGuestHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        return await handler.HandleAsync(userId, id, ClientInfo.From(http), cancellationToken)
            ? TypedResults.NoContent()
            : TypedResults.NotFound();
    }
}
