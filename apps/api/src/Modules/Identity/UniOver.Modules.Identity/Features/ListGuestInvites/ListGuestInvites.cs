using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.ListGuestInvites;

/// <summary>Um convite como o dono o vê. Nunca leva o segredo do link (ele só aparece na criação).</summary>
/// <param name="Status"><c>pending</c>, <c>used</c>, <c>revoked</c> ou <c>expired</c>.</param>
/// <param name="Permissions">O que o convite concede quando for aceito (identificadores do catálogo).</param>
internal sealed record GuestInviteSummary(
    Guid Id,
    string DisplayName,
    string Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? UsedAt,
    DateTimeOffset? RevokedAt,
    IReadOnlyList<string> Permissions);

internal sealed class ListGuestInvitesHandler(IdentityDbContext db, TimeProvider time)
{
    public const int Limit = 50;

    public async Task<IReadOnlyList<GuestInviteSummary>> HandleAsync(CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        var invites = await db.GuestInvites.AsNoTracking()
            .OrderByDescending(i => i.CreatedAt)
            .Take(Limit)
            .ToListAsync(cancellationToken);

        return [.. invites.Select(i => new GuestInviteSummary(
            i.Id, i.Label, StatusText(i.StatusAt(now)), i.CreatedAt, i.ExpiresAt, i.UsedAt, i.RevokedAt,
            PermissionRules.Effective(i.Permissions)))];
    }

    internal static string StatusText(InviteStatus status) => status switch
    {
        InviteStatus.Pending => "pending",
        InviteStatus.Used => "used",
        InviteStatus.Revoked => "revoked",
        _ => "expired",
    };
}

internal static class ListGuestInvitesEndpoint
{
    public static void MapListGuestInvites(this IEndpointRouteBuilder group) =>
        group.MapGet("/guest-invites", HandleAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<IReadOnlyList<GuestInviteSummary>>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(ListGuestInvitesHandler handler, CancellationToken cancellationToken) =>
        TypedResults.Ok(await handler.HandleAsync(cancellationToken));
}
