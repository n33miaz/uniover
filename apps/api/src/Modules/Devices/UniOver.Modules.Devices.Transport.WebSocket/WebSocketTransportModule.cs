using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Ports;

namespace UniOver.Modules.Devices.Transport.WebSocket;

/// <summary>Composição do adaptador WebSocket; o Host chama estas duas junto das do núcleo do transporte.</summary>
public static class WebSocketTransportModule
{
    public const string RoutePattern = "/api/v1/devices/agents/{agentId}/ws";

    public static IServiceCollection AddDevicesWebSocketTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<WebSocketAgentTransport>();
        services.AddSingleton<IAgentTransport>(sp => sp.GetRequiredService<WebSocketAgentTransport>());
        return services;
    }

    /// <summary>
    /// Mapeia <c>GET /api/v1/devices/agents/{agentId}/ws</c>. O suporte a WebSocket é ligado só nesta rota (um
    /// pipeline próprio), então não depende de o Host chamar <c>UseWebSockets</c>. A rota exige o token de
    /// dispositivo (política do módulo) e usa o limite de requisições do pareamento.
    /// </summary>
    public static IEndpointConventionBuilder MapDevicesWebSocketTransport(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var pipeline = endpoints.CreateApplicationBuilder();
        pipeline.UseWebSockets();
        pipeline.Run(context => context.RequestServices.GetRequiredService<WebSocketAgentTransport>().HandleAsync(context));

        return endpoints.MapMethods(RoutePattern, ["GET"], pipeline.Build())
            .RequireAuthorization(DeviceAuth.AgentPolicy)
            .RequireRateLimiting(RateLimitPolicies.Pairing);
    }
}
