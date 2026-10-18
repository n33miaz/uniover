using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace UniOver.Modules.Identity.Features.GetModuleInfo;

internal static class GetModuleInfoEndpoint
{
    public static void MapGetModuleInfo(this IEndpointRouteBuilder group) =>
        group.MapGet("/info", async (GetModuleInfoHandler handler, CancellationToken ct) =>
            TypedResults.Ok(await handler.HandleAsync(ct)));
}
