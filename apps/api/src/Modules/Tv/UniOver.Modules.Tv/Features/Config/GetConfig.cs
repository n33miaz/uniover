using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Config;

internal sealed class GetConfigHandler(ITvAgentResolver agents, TvConfigView view)
{
    public async Task<TvConfigResponse> HandleAsync(CancellationToken cancellationToken) =>
        await view.ReadAsync(await agents.ResolveAsync(cancellationToken), cancellationToken);
}

internal static class GetConfigEndpoint
{
    /// <summary>
    /// Só o administrador: a resposta traz os computadores pareados do sistema. Sem política de permissão da TV de
    /// propósito: configurar a TV não é uma ação de quem a usa, e uma rota nova sem política já seria só do administrador.
    /// </summary>
    public static void MapGetConfig(this IEndpointRouteBuilder group) =>
        group.MapGet("/config", async (HttpRequest request, GetConfigHandler handler, CancellationToken cancellationToken) =>
                LegacyConfigRoute.RejectTvId(request) ?? TypedResults.Ok(await handler.HandleAsync(cancellationToken)))
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<TvConfigResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
}

internal static class LegacyConfigRoute
{
    public static IResult? RejectTvId(HttpRequest request) => request.Query.ContainsKey("tvId")
        ? Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Esta rota não aceita a seleção de TV.")
        : null;
}
