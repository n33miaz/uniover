using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Sessions;

internal sealed record SessionSummary(
    Guid Id, string? UserAgent, string? Ip, DateTimeOffset CreatedAt, DateTimeOffset LastUsedAt, bool IsCurrent,
    string? Platform = null, bool? Installed = null);

internal sealed class SessionHandler(IdentityDbContext db, LoginAuditWriter audit, TimeProvider time)
{
    public async Task<IReadOnlyList<SessionSummary>> ListAsync(
        Guid userId, Guid? currentId, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var activeFamilies = db.RefreshTokens.AsNoTracking()
            .Where(t => t.UserId == userId && t.UsedAt == null && t.RevokedAt == null && t.ExpiresAt > now)
            .Select(t => t.FamilyId);
        var tokens = await db.RefreshTokens.AsNoTracking()
            .Where(t => t.UserId == userId && activeFamilies.Contains(t.FamilyId))
            .Select(t => new { t.FamilyId, t.CreatedAt, t.UsedAt, t.Ip, t.UserAgent, t.ClientPlatform, t.ClientInstalled })
            .ToListAsync(cancellationToken);

        return [.. tokens.GroupBy(t => t.FamilyId).Select(family =>
        {
            var agent = family.Where(t => t.UserAgent is not null).MaxBy(t => t.CreatedAt);
            var location = family.Where(t => t.Ip is not null).MaxBy(t => t.CreatedAt);

            // O que o app informou mais recentemente; um refresh de app antigo (sem cabeçalho) não apaga o que já se sabia.
            var env = family.Where(t => t.ClientPlatform is not null).MaxBy(t => t.CreatedAt);
            return new SessionSummary(
                family.Key, agent?.UserAgent, MaskIp(location?.Ip), family.Min(t => t.CreatedAt),
                family.Max(t => t.UsedAt ?? t.CreatedAt), family.Key == currentId,
                env?.ClientPlatform, env?.ClientInstalled);
        }).OrderByDescending(s => s.LastUsedAt)];
    }

    public Task<bool> IsGuestAsync(Guid userId, CancellationToken cancellationToken) =>
        db.Users.AnyAsync(u => u.Id == userId && u.Role == AccountRoles.Guest, cancellationToken);

    public async Task<bool> RevokeAsync(
        Guid actorId, Guid userId, Guid familyId, ClientInfo client, CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await LockFamilyAsync(familyId, cancellationToken);
        // O id da família sozinho não autoriza a operação: a linha precisa pertencer à conta escolhida.
        if (!await db.RefreshTokens.AnyAsync(t => t.UserId == userId && t.FamilyId == familyId, cancellationToken))
        {
            return false;
        }

        await RevokeFamilyAsync(actorId, userId, familyId, client, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return true;
    }

    public async Task RevokeOthersAsync(Guid userId, Guid currentId, ClientInfo client, CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var now = time.GetUtcNow();
        var families = await db.RefreshTokens.AsNoTracking()
            .Where(t => t.UserId == userId && t.FamilyId != currentId
                && t.UsedAt == null && t.RevokedAt == null && t.ExpiresAt > now)
            .Select(t => t.FamilyId).Distinct().OrderBy(id => id).ToListAsync(cancellationToken);
        foreach (var familyId in families)
        {
            await LockFamilyAsync(familyId, cancellationToken);
            await RevokeFamilyAsync(userId, userId, familyId, client, cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
    }

    private async Task RevokeFamilyAsync(
        Guid actorId, Guid userId, Guid familyId, ClientInfo client, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var changed = await db.RefreshTokens
            .Where(t => t.UserId == userId && t.FamilyId == familyId && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedAt, now)
                .SetProperty(t => t.RevokedReason, RevokeReasons.SessionRevoked), cancellationToken);
        if (changed == 0) return;

        await db.StepUpConfirmations.Where(c => c.UserId == userId && c.SessionFamilyId == familyId)
            .ExecuteDeleteAsync(cancellationToken);
        audit.Add(actorId, AuditEvents.SessionRevoked, client, $"{userId:N}|{familyId:N}");
        await db.SaveChangesAsync(cancellationToken);
    }

    private Task LockFamilyAsync(Guid familyId, CancellationToken cancellationToken) =>
        FamilyLock.AcquireAsync(db, familyId, cancellationToken);

    private static string? MaskIp(string? value)
    {
        if (!IPAddress.TryParse(value, out var address)) return null;
        var bytes = address.GetAddressBytes();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            bytes[3] = 0;
            return $"{new IPAddress(bytes)}/24";
        }

        Array.Clear(bytes, 8, 8);
        return $"{new IPAddress(bytes)}/64";
    }
}

internal static class SessionsEndpoint
{
    public static void MapSessions(this IEndpointRouteBuilder group)
    {
        group.MapGet("/sessions", ListOwnAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .Produces<IReadOnlyList<SessionSummary>>();
        group.MapPost("/sessions/{id:guid}/revoke", RevokeOwnAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireIdempotency<IdentityDbContext>()
            .Produces(StatusCodes.Status204NoContent);
        group.MapPost("/sessions/others/revoke", RevokeOthersAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireIdempotency<IdentityDbContext>()
            .Produces(StatusCodes.Status204NoContent);
        group.MapGet("/guests/{guestId:guid}/sessions", ListGuestAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<IReadOnlyList<SessionSummary>>();
        group.MapPost("/guests/{guestId:guid}/sessions/{id:guid}/revoke", RevokeGuestAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireIdempotency<IdentityDbContext>()
            .Produces(StatusCodes.Status204NoContent);
    }

    private static async Task<IResult> ListOwnAsync(ICurrentUser current, SessionHandler handler, CancellationToken ct) =>
        current.UserId is { } userId
            ? TypedResults.Ok(await handler.ListAsync(userId, current.SessionId, ct))
            : IdentityProblems.Unauthenticated();

    private static async Task<IResult> ListGuestAsync(
        Guid guestId, SessionHandler handler, CancellationToken ct) =>
        await handler.IsGuestAsync(guestId, ct)
            ? TypedResults.Ok(await handler.ListAsync(guestId, null, ct))
            : TypedResults.NotFound();

    private static async Task<IResult> RevokeOwnAsync(
        Guid id, HttpContext http, ICurrentUser current, SessionHandler handler, AuthCookieWriter cookies, CancellationToken ct)
    {
        if (current.UserId is not { } userId) return IdentityProblems.Unauthenticated();
        if (!await handler.RevokeAsync(userId, userId, id, ClientInfo.From(http), ct)) return TypedResults.NotFound();
        if (id == current.SessionId)
        {
            cookies.DeleteRefresh(http.Response);
            cookies.DeleteStream(http.Response);
        }
        return TypedResults.NoContent();
    }

    private static async Task<IResult> RevokeOthersAsync(
        HttpContext http, ICurrentUser current, SessionHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
            return IdentityProblems.Unauthenticated();
        await handler.RevokeOthersAsync(userId, sessionId, ClientInfo.From(http), ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> RevokeGuestAsync(
        Guid guestId, Guid id, HttpContext http, ICurrentUser current, SessionHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } ownerId) return IdentityProblems.Unauthenticated();
        if (!await handler.IsGuestAsync(guestId, ct)
            || !await handler.RevokeAsync(ownerId, guestId, id, ClientInfo.From(http), ct))
            return TypedResults.NotFound();
        return TypedResults.NoContent();
    }
}
