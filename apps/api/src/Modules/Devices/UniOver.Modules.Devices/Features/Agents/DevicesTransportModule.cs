using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Adapters;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Contracts.Pairing;
using UniOver.Modules.Devices.Features.Events;
using UniOver.Modules.Devices.Features.Presence;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>
/// Registro do núcleo do transporte do agente (as extensões do <c>DevicesModule</c> pertencem ao pareamento; estas são
/// do transporte). O adaptador do WebSocket tem as suas próprias extensões no projeto dele: o núcleo não o conhece.
/// </summary>
public static class DevicesTransportModule
{
    public static IServiceCollection AddDevicesTransport(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.AddOptions<DevicesTransportOptions>()
            .Bind(configuration.GetSection(DevicesTransportOptions.SectionName))
            .Validate(DevicesTransportOptions.IsValid, "Modules:Devices:Transport tem valor fora do permitido (tempos e limites devem ser positivos).")
            .ValidateOnStart();

        // O mesmo relógio para o envelope de saída e para os prazos: nos testes o tempo falso vale para os dois.
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<IClock, TimeProviderClock>();
        services.TryAddSingleton<AgentEnvelopeValidator>();
        services.TryAddSingleton<OutboundEnvelopeFactory>();

        // A conexão viva fica em memória; o último contato e os detalhes chegam ao banco por um gravador separado.
        services.AddSingleton<InMemoryPresenceStore>();
        services.AddSingleton<IPresenceStore>(sp => sp.GetRequiredService<InMemoryPresenceStore>());
        services.AddSingleton<IAgentPresenceReader>(sp => sp.GetRequiredService<InMemoryPresenceStore>());
        services.AddSingleton<AgentPresencePersistence>();
        services.AddSingleton(sp => new SseBroadcaster<PresenceUpdate>(
            sp.GetRequiredService<IOptions<DevicesTransportOptions>>().Value.Sse));

        services.AddSingleton<AgentConnections>();
        services.AddSingleton<IAgentSessionCloser>(sp => sp.GetRequiredService<AgentConnections>());
        services.AddSingleton<IReplyCorrelator, ReplyCorrelator>();
        services.AddSingleton<IAgentLogReports, InMemoryAgentLogReports>();
        services.AddSingleton<AgentHub>();
        services.AddSingleton<AgentGateway>();
        services.AddSingleton<IAgentGateway>(sp => sp.GetRequiredService<AgentGateway>());
        services.AddHostedService<AgentTransportListener>();

        // Revogar fecha a conexão viva (o evento já existe desde o pareamento; este é outro assinante).
        services.AddScoped<IIntegrationEventHandler<AgentRevoked>, AgentRevokedSessionCloser>();

        // Autenticação do agente: esquema do token de dispositivo e a política que a rota de conexão declara.
        services.AddHttpContextAccessor();
        services.AddAuthentication()
            .AddScheme<AuthenticationSchemeOptions, DeviceTokenAuthentication>(DeviceAuth.Scheme, _ => { });
        services.AddSingleton<IAuthorizationHandler, AgentRouteAuthorizer>();
        services.AddAuthorizationBuilder().AddPolicy(DeviceAuth.AgentPolicy, policy => policy
            .AddAuthenticationSchemes(DeviceAuth.Scheme)
            .RequireAuthenticatedUser()
            .AddRequirements(new AgentRouteRequirement()));
        return services;
    }

    /// <summary>Rotas do núcleo do transporte (o fluxo SSE). A rota do WebSocket vem do adaptador.</summary>
    public static IEndpointRouteBuilder MapDevicesTransport(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup($"/api/v1/{DevicesModule.Name}");
        group.MapStreamEvents();
        return endpoints;
    }
}
