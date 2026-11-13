using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>Os números da paridade de cada computador com uso na janela; o computador sem nada nela não vem (a tela mostra "—").</summary>
internal sealed record AgentParityResponse(int WindowMinutes, IReadOnlyList<AgentParitySnapshot> Agents);

internal static class AgentParityEndpoint
{
    /// <summary>
    /// <c>GET /api/v1/devices/agents/parity</c>, só do dono: lê a memória e nada mais (nem o banco, nem o agente), para a tela da
    /// saúde poder abrir com o Neon dormindo.
    /// </summary>
    public static void MapAgentParity(this IEndpointRouteBuilder group) =>
        group.MapGet("/agents/parity", (AgentParity parity) =>
                TypedResults.Ok(new AgentParityResponse((int)AgentParity.Window.TotalMinutes, parity.Snapshot())))
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<AgentParityResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
}
