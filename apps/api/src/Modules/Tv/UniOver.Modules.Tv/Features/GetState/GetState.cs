using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;

namespace UniOver.Modules.Tv.Features.GetState;

internal sealed class GetStateHandler(TvStateProvider provider)
{
    public TvState Handle() => provider.Current();
}

internal static class GetStateEndpoint
{
    public static void MapGetState(this IEndpointRouteBuilder group) =>
        group.MapGet("/state", (GetStateHandler handler) => TypedResults.Ok(handler.Handle()))
            .RequireAuthorization(TvAuth.Module)
            .Produces<TvState>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);
}
