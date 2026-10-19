using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.ListAgents;

/// <summary>
/// <c>LastSeenAt</c> é o último sinal do agente desde que a API subiu (conexão ou mensagem); nulo se ele ainda não
/// apareceu nesta execução. Vem da presença em memória: gravar no banco a cada mensagem acordaria o Postgres.
/// </summary>
internal sealed record AgentSummary(
    Guid Id, string Slug, string Name, string Platform, DateTimeOffset CreatedAt, bool Revoked, DateTimeOffset? LastSeenAt);

internal sealed class ListAgentsHandler(DevicesDbContext db, IAgentPresenceReader presence)
{
    public async Task<IReadOnlyList<AgentSummary>> HandleAsync(CancellationToken cancellationToken = default)
    {
        var agents = await db.Agents.AsNoTracking()
            .OrderBy(a => a.CreatedAt)
            .Select(a => new { a.Id, a.Slug, a.Name, a.Platform, a.CreatedAt, Revoked = a.RevokedAt != null })
            .ToListAsync(cancellationToken);

        return [.. agents.Select(a => new AgentSummary(
            a.Id, a.Slug, a.Name, a.Platform, a.CreatedAt, a.Revoked, LastSeen(presence.Get(a.Slug))))];
    }

    private static DateTimeOffset? LastSeen(AgentPresenceInfo? info) =>
        info is null ? null : info.LastMessageAt ?? info.ConnectedSince;
}

internal static class ListAgentsEndpoint
{
    public static void MapListAgents(this IEndpointRouteBuilder group) =>
        group.MapGet("/agents", async (ListAgentsHandler handler, CancellationToken cancellationToken) =>
            TypedResults.Ok(await handler.HandleAsync(cancellationToken)))
            .RequireAuthorization()
            .ProducesProblem(StatusCodes.Status401Unauthorized);
}
