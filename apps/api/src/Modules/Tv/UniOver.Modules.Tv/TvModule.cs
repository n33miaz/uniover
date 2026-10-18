using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Features.GetModuleInfo;

namespace UniOver.Modules.Tv;

public static class TvModule
{
    public const string Name = "tv";

    public static IServiceCollection AddTvModule(this IServiceCollection services, IConfiguration configuration)
    {
        // O handler recebe só o valor da seção "Modules:Tv": módulo nenhum lê a configuração de outro.
        var version = configuration.GetSection("Modules:Tv")["Version"] ?? "0.0.0";
        services.AddSingleton(new GetModuleInfoHandler(version));
        services.AddScoped<ITvModule, TvModuleApi>();
        return services;
    }

    public static IEndpointRouteBuilder MapTvEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup($"/api/v1/{Name}").AllowAnonymous();
        group.MapGetModuleInfo();
        return endpoints;
    }
}
