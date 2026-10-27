using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Adapters;
using UniOver.Modules.Devices.Audit;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Contracts.Pairing;
using UniOver.Modules.Devices.Features.ApprovePairing;
using UniOver.Modules.Devices.Features.DenyPairing;
using UniOver.Modules.Devices.Features.GetModuleInfo;
using UniOver.Modules.Devices.Features.ListAgents;
using UniOver.Modules.Devices.Features.PollPairing;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Features.RevokeAgent;
using UniOver.Modules.Devices.Features.StartPairing;
using UniOver.Modules.Devices.Features.Tokens;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Devices;

public static class DevicesModule
{
    public const string Name = "devices";

    public static IServiceCollection AddDevicesModule(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        var version = configuration.GetSection(DevicesModuleOptions.SectionName)["Version"] ?? "0.0.0";

        services.AddOptions<DevicesModuleOptions>()
            .Bind(configuration.GetSection(DevicesModuleOptions.SectionName))
            .Validate(DevicesModuleOptions.IsValid, "Modules:Devices tem valor fora do permitido (tempos e limites devem ser positivos).")
            .ValidateOnStart();

        services.TryAddSingleton(TimeProvider.System);
        services.AddModuleDbContext<DevicesDbContext>(
            configuration, DevicesDbContext.SchemaName, typeof(DevicesDbContext).Assembly);

        // Aprovações e revogações podem ser reenviadas pela fila offline; as chaves ficam no schema devices.
        services.AddIdempotencyStore<DevicesDbContext>();
        services.AddScoped<IIdempotencyGateway<DevicesDbContext>, DevicesIdempotencyGateway>();

        // Eventos pela outbox do schema devices. Os dois tipos precisam estar registrados para o despachante
        // reconhecê-los; só a revogação tem assinante (o cache de tokens).
        services.AddModuleOutbox<DevicesDbContext>(Name);
        services.AddIntegrationEvent<AgentPaired>(AgentPaired.EventType);
        services.AddIntegrationEvent<AgentRevoked>(AgentRevoked.EventType);
        services.AddScoped<IIntegrationEventHandler<AgentRevoked>, AgentRevokedCacheInvalidator>();

        // Leitura dos agentes pareados para quem precisa escolher ou conferir um (hoje, a TV), pelo Contracts.
        services.AddScoped<IAgentDirectory, EfAgentDirectory>();

        services.AddSingleton<IDeviceTokenCache, InMemoryDeviceTokenCache>();
        services.AddScoped<IDeviceTokenValidator, DeviceTokenValidator>();
        services.AddScoped<PairingAuditWriter>();

        // Auditoria: o pareamento é uma fonte da trilha do administrador. A retenção roda no banco; a aplicação só chama a função.
        services.AddScoped<IAuditSource, DevicesAuditSource>();
        services.AddAuditPurge<DevicesDbContext>(
            configuration, DevicesDbContext.SchemaName, "purge_audit", AuditRetentionPolicy.SecurityDays);

        services.AddSingleton(new GetModuleInfoHandler(version));
        services.AddScoped<StartPairingHandler>();
        services.AddScoped<PollPairingHandler>();
        services.AddScoped<ApprovePairingHandler>();
        services.AddScoped<DenyPairingHandler>();
        services.AddScoped<ListAgentsHandler>();
        services.AddScoped<RevokeAgentHandler>();
        services.AddSingleton(sp => new PublishedBuild(
            sp.GetRequiredService<IConfiguration>()["RENDER_GIT_COMMIT"]?.Trim().ToLowerInvariant(),
            sp.GetRequiredService<TimeProvider>().GetUtcNow()));
        services.AddScoped<RemoteCareResolver>();
        services.AddScoped<AgentLogsHandler>();
        services.AddScoped<AgentMaintenanceHandler>();
        services.AddAuthorizationBuilder().AddPolicy(PairingPolicies.ApproveOwn, PairingPolicies.Configure);
        return services;
    }

    public static IEndpointRouteBuilder MapDevicesEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        // Sem AllowAnonymous no grupo: a política padrão é "autenticado" e cada rota pública se declara.
        var group = endpoints.MapGroup($"/api/v1/{Name}");
        group.MapGetModuleInfo();
        group.MapStartPairing();
        group.MapPollPairing();
        group.MapApprovePairing();
        group.MapApproveOwnPairing();
        group.MapDenyPairing();
        group.MapListAgents();
        group.MapRevokeAgent();
        group.MapAgentLogs();
        group.MapAgentMaintenance();
        return endpoints;
    }
}
