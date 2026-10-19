using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace UniOver.Modules.Devices.Features.GetModuleInfo;

public sealed record DevicesModuleInfo(string Module, string Version);

public sealed class GetModuleInfoHandler(string version)
{
    public DevicesModuleInfo Handle() => new(DevicesModule.Name, version);
}

internal static class GetModuleInfoEndpoint
{
    // Pública como a dos outros módulos: só nome e versão, nenhum dado do usuário.
    public static void MapGetModuleInfo(this IEndpointRouteBuilder group) =>
        group.MapGet("/info", (GetModuleInfoHandler handler) => TypedResults.Ok(handler.Handle())).AllowAnonymous();
}
