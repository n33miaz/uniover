using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.ListAgents;

/// <summary>
/// <c>LastSeenAt</c> é o último sinal do agente desde que a API subiu (conexão ou mensagem); nulo se ele ainda não
/// apareceu nesta execução. Vem da presença em memória: gravar no banco a cada mensagem acordaria o Postgres.
/// Os campos de manutenção vêm do <c>hello</c> do agente e ficam vazios até ele falar: <c>AgentVersion</c> e
/// <c>AgentBuild</c> (o commit instalado, curto), <c>Os</c>, <c>TvKind</c> e <c>TvHost</c>. <c>CanReadLogs</c> e
/// <c>CanMaintain</c> dizem o que o agente sabe fazer (falso = a tela pede para atualizar o agente).
/// <c>Update</c> é o estado da auto-atualização (vazio = agente antigo, que não conta isso: "versão desconhecida") e
/// <c>CanRollback</c> diz que há uma versão anterior guardada para voltar atrás.
/// </summary>
internal sealed record AgentSummary(
    Guid Id,
    string Slug,
    string Name,
    string Platform,
    DateTimeOffset CreatedAt,
    bool Revoked,
    DateTimeOffset? LastSeenAt,
    bool Connected = false,
    string? AgentVersion = null,
    string? AgentBuild = null,
    string? Os = null,
    string? TvKind = null,
    string? TvHost = null,
    bool CanReadLogs = false,
    bool CanMaintain = false,
    AgentUpdateSummary? Update = null,
    bool CanRollback = false);

internal sealed class ListAgentsHandler(DevicesDbContext db, IAgentPresenceReader presence, PublishedBuild publishedBuild)
{
    public async Task<IReadOnlyList<AgentSummary>> HandleAsync(CancellationToken cancellationToken = default)
    {
        var agents = await db.Agents.AsNoTracking()
            .OrderBy(a => a.CreatedAt)
            .Select(a => new { a.Id, a.Slug, a.Name, a.Platform, a.CreatedAt, Revoked = a.RevokedAt != null })
            .ToListAsync(cancellationToken);

        return [.. agents.Select(a => Summarize(a.Id, a.Slug, a.Name, a.Platform, a.CreatedAt, a.Revoked, presence.Get(a.Slug), publishedBuild))];
    }

    private static AgentSummary Summarize(
        Guid id,
        string slug,
        string name,
        string platform,
        DateTimeOffset createdAt,
        bool revoked,
        AgentPresenceInfo? info,
        PublishedBuild publishedBuild)
    {
        // O hello manda "0.1.0+3f2a9c1d4e5b": o pacote e, depois do mais, o commit instalado.
        var (version, build) = SplitVersion(info?.AgentVersion);
        var capabilities = info?.Capabilities ?? [];
        return new AgentSummary(
            id,
            slug,
            name,
            platform,
            createdAt,
            revoked,
            LastSeen(info),
            info?.Connected ?? false,
            version,
            build,
            info?.Host?.Os,
            info?.Host?.TvKind,
            info?.Host?.TvHost,
            !revoked && capabilities.Contains(RemoteCareDefaults.LogsCapability, StringComparer.Ordinal),
            !revoked && capabilities.Contains(RemoteCareDefaults.MaintenanceCapability, StringComparer.Ordinal),
            AgentUpdateSummary.From(info?.Update, publishedBuild),
            !revoked
                && capabilities.Contains(RemoteCareDefaults.MaintenanceCapability, StringComparer.Ordinal)
                && info?.Update?.PreviousSha is not null);
    }

    private static (string? Version, string? Build) SplitVersion(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return (null, null);
        }

        var plus = raw.IndexOf('+', StringComparison.Ordinal);
        return plus < 0 ? (raw, null) : (raw[..plus], raw[(plus + 1)..]);
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
