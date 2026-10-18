using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace UniOver.Modules.Tv.Features.GetModuleInfo;

internal static class GetModuleInfoEndpoint
{
    public static void MapGetModuleInfo(this IEndpointRouteBuilder group) =>
        group.MapGet("/info", (GetModuleInfoHandler handler) => TypedResults.Ok(handler.Handle()));
}
