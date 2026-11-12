using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Hosting;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.Presence;

namespace UniOver.Modules.Devices.Features.Events;

internal static class StreamEventsEndpoint
{
    /// <summary>
    /// Fluxo SSE do estado dos aparelhos. Só o cookie de bilhete de stream vale (política <c>StreamAccess</c>, só GET):
    /// token na URL nunca é aceito. Ao abrir envia o instantâneo da presença e depois cada mudança.
    /// </summary>
    public static void MapStreamEvents(this IEndpointRouteBuilder group) =>
        group.MapGet("/events", Handle).RequireAuthorization(UniOverAuth.StreamPolicy)
            .Produces(StatusCodes.Status200OK, contentType: "text/event-stream")
            .ProducesProblem(StatusCodes.Status401Unauthorized);

    private static IResult Handle(
        ICurrentUser current,
        IAgentPresenceReader presence,
        AgentHealth health,
        SseBroadcaster<PresenceUpdate> broadcaster,
        TimeProvider time,
        IHostApplicationLifetime lifetime)
    {
        // O limite de fluxos é por usuário; a política já garantiu o bilhete válido, então o "sub" existe.
        if (current.UserId is not { } userId)
        {
            return TypedResults.Unauthorized();
        }

        var subscription = broadcaster.Subscribe(
            userId.ToString(),
            () => [new SseMessage<PresenceUpdate>(PresenceUpdate.SnapshotEvent, new PresenceUpdate(WithHealth(presence.All(), health)))]);
        return SseResults.Stream(subscription, broadcaster.Options, time, lifetime.ApplicationStopping);
    }

    /// <summary>O instantâneo leva a saúde de quem está conectado e é medido, para quem reabre o fluxo não perdê-la.</summary>
    private static List<AgentPresenceInfo> WithHealth(IReadOnlyList<AgentPresenceInfo> agents, AgentHealth health) =>
        [.. agents.Select(a => a.Connected && health.Describe(a.AgentId) is { } state ? a with { Health = state } : a)];
}
