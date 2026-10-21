using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.ListGuests;

/// <summary>
/// Um convidado como o dono o vê. <c>DisabledAt</c> preenchido = acesso revogado. <c>Permissions</c> são as permissões em
/// vigor, na ordem do catálogo (nunca o texto: ele vive na tela).
/// </summary>
internal sealed record GuestSummary(
    Guid Id,
    string DisplayName,
    string Email,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt,
    IReadOnlyList<string> Permissions);

internal sealed class ListGuestsHandler(IdentityDbContext db)
{
    public async Task<IReadOnlyList<GuestSummary>> HandleAsync(CancellationToken cancellationToken = default)
    {
        var guests = await db.Users.AsNoTracking()
            .Where(u => u.Role == AccountRoles.Guest)
            .OrderBy(u => u.CreatedAt)
            .Select(u => new { u.Id, u.DisplayName, u.Email, u.CreatedAt, u.DisabledAt })
            .ToListAsync(cancellationToken);

        var ids = guests.Select(g => g.Id).ToList();
        var grants = (await db.UserGrants.AsNoTracking()
                .Where(g => ids.Contains(g.UserId))
                .Select(g => new { g.UserId, g.Permission })
                .ToListAsync(cancellationToken))
            .ToLookup(g => g.UserId, g => g.Permission);

        return [.. guests.Select(g => new GuestSummary(
            g.Id, g.DisplayName, g.Email, g.CreatedAt, g.DisabledAt, PermissionRules.Effective(grants[g.Id])))];
    }
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
