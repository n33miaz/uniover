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

    /// <summary>A rota da versão nova do agente na passagem sem queda (conexão candidata): uma API sem a passagem responde 404.</summary>
    public const string HandoverRoutePattern = RoutePattern + "/handover";

    public static IServiceCollection AddDevicesWebSocketTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<WebSocketAgentTransport>();
        services.AddSingleton<IAgentTransport>(sp => sp.GetRequiredService<WebSocketAgentTransport>());
        return services;
    }

    /// <summary>
    /// Mapeia <c>GET /api/v1/devices/agents/{agentId}/ws</c> (e <c>/ws/handover</c>, a da candidata da passagem). O suporte a WebSocket é ligado só nesta rota (um
    /// pipeline próprio), então não depende de o Host chamar <c>UseWebSockets</c>. A rota exige o token de
    /// dispositivo (política do módulo) e usa o limite de requisições do pareamento.
    /// </summary>
    public static IEndpointConventionBuilder MapDevicesWebSocketTransport(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        return new EndpointConventionGroup(
            MapChannel(endpoints, RoutePattern, handoverCandidate: false),
            MapChannel(endpoints, HandoverRoutePattern, handoverCandidate: true));
    }

    private static IEndpointConventionBuilder MapChannel(IEndpointRouteBuilder endpoints, string pattern, bool handoverCandidate)
    {
        var pipeline = endpoints.CreateApplicationBuilder();
        pipeline.UseWebSockets();
        pipeline.Run(context => context.RequestServices.GetRequiredService<WebSocketAgentTransport>().HandleAsync(context, handoverCandidate));

        return endpoints.MapMethods(pattern, ["GET"], pipeline.Build())
            .RequireAuthorization(DeviceAuth.AgentPolicy)
            .RequireRateLimiting(RateLimitPolicies.Pairing);
    }

    /// <summary>As duas rotas do canal recebem juntas as convenções que o Host acrescentar.</summary>
    private sealed class EndpointConventionGroup(params IEndpointConventionBuilder[] builders) : IEndpointConventionBuilder
    {
        public void Add(Action<EndpointBuilder> convention)
        {
            foreach (var builder in builders)
            {
                builder.Add(convention);
            }
        }
    }
}
