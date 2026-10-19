using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.ListAgents;

internal sealed record AgentSummary(Guid Id, string Slug, string Name, string Platform, DateTimeOffset CreatedAt, bool Revoked);

internal sealed class ListAgentsHandler(DevicesDbContext db)
{
    public async Task<IReadOnlyList<AgentSummary>> HandleAsync(CancellationToken cancellationToken = default) =>
        await db.Agents.AsNoTracking()
            .OrderBy(a => a.CreatedAt)
            .Select(a => new AgentSummary(a.Id, a.Slug, a.Name, a.Platform, a.CreatedAt, a.RevokedAt != null))
            .ToListAsync(cancellationToken);
}

internal static class ListAgentsEndpoint
{
    public static void MapListAgents(this IEndpointRouteBuilder group) =>
        group.MapGet("/agents", async (ListAgentsHandler handler, CancellationToken cancellationToken) =>
            TypedResults.Ok(await handler.HandleAsync(cancellationToken)))
            .RequireAuthorization();
}
