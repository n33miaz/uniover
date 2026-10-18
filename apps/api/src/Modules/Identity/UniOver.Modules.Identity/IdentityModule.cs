using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Identity.Features.GetModuleInfo;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Identity;

public static class IdentityModule
{
    public const string Name = "identity";

    public static IServiceCollection AddIdentityModule(this IServiceCollection services, IConfiguration configuration)
    {
        var version = configuration.GetSection("Modules:Identity")["Version"] ?? "0.0.0";
        services.AddScoped(sp => new GetModuleInfoHandler(version, sp.GetRequiredService<ITvModule>()));
        return services;
    }

    public static IEndpointRouteBuilder MapIdentityEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup($"/api/v1/{Name}").AllowAnonymous();
        group.MapGetModuleInfo();
        return endpoints;
    }
}
