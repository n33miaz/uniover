using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.ListGuests;

/// <summary>Um convidado como o dono o vê. <c>DisabledAt</c> preenchido = acesso revogado.</summary>
internal sealed record GuestSummary(Guid Id, string DisplayName, string Email, DateTimeOffset CreatedAt, DateTimeOffset? DisabledAt);

internal sealed class ListGuestsHandler(IdentityDbContext db)
{
    public async Task<IReadOnlyList<GuestSummary>> HandleAsync(CancellationToken cancellationToken = default) =>
        await db.Users.AsNoTracking()
            .Where(u => u.Role == AccountRoles.Guest)
            .OrderBy(u => u.CreatedAt)
            .Select(u => new GuestSummary(u.Id, u.DisplayName, u.Email, u.CreatedAt, u.DisabledAt))
            .ToListAsync(cancellationToken);
}

internal static class ListGuestsEndpoint
{
    public static void MapListGuests(this IEndpointRouteBuilder group) =>
        group.MapGet("/guests", HandleAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<IReadOnlyList<GuestSummary>>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(ListGuestsHandler handler, CancellationToken cancellationToken) =>
        TypedResults.Ok(await handler.HandleAsync(cancellationToken));
}
