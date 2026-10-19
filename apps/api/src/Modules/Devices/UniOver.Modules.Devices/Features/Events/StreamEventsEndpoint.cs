using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Hosting;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Presence;

namespace UniOver.Modules.Devices.Features.Events;

internal static class StreamEventsEndpoint
{
    /// <summary>
    /// Fluxo SSE do estado dos aparelhos. Só o cookie de bilhete de stream vale (política <c>StreamAccess</c>, só GET):
    /// token na URL nunca é aceito. Ao abrir envia o instantâneo da presença e depois cada mudança.
    /// </summary>
    public static void MapStreamEvents(this IEndpointRouteBuilder group) =>
        group.MapGet("/events", Handle).RequireAuthorization(UniOverAuth.StreamPolicy);

    private static IResult Handle(
        ICurrentUser current,
        IAgentPresenceReader presence,
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
            () => [new SseMessage<PresenceUpdate>(PresenceUpdate.SnapshotEvent, new PresenceUpdate(presence.All()))]);
        return SseResults.Stream(subscription, broadcaster.Options, time, lifetime.ApplicationStopping);
    }
}
