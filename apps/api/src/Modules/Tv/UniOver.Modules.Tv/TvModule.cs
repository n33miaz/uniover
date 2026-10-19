using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Features.Agents;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Events;
using UniOver.Modules.Tv.Features.GetModuleInfo;
using UniOver.Modules.Tv.Features.GetState;
using UniOver.Modules.Tv.Features.LaunchShortcut;
using UniOver.Modules.Tv.Features.ListShortcuts;
using UniOver.Modules.Tv.Features.PowerOff;
using UniOver.Modules.Tv.Features.RecentCommands;
using UniOver.Modules.Tv.Features.RefreshShortcuts;
using UniOver.Modules.Tv.Features.SendKey;
using UniOver.Modules.Tv.Features.SendText;
using UniOver.Modules.Tv.Features.UpdateShortcut;
using UniOver.Modules.Tv.Features.Wake;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv;

public static class TvModule
{
    public const string Name = "tv";

    public static IServiceCollection AddTvModule(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        // O handler recebe só o valor da seção "Modules:Tv": módulo nenhum lê a configuração de outro.
        var version = configuration.GetSection(TvModuleOptions.SectionName)["Version"] ?? "0.0.0";

        // O AgentId pode ficar vazio: a API sobe sem TV configurada e os comandos respondem 503.
        services.AddOptions<TvModuleOptions>()
            .Bind(configuration.GetSection(TvModuleOptions.SectionName))
            .Validate(TvModuleOptions.IsValid, "Modules:Tv tem valor fora do permitido (tempos devem ser positivos).")
            .ValidateOnStart();

        services.TryAddSingleton(TimeProvider.System);
        services.AddModuleDbContext<TvDbContext>(configuration, TvDbContext.SchemaName, typeof(TvDbContext).Assembly);

        // Eventos pela outbox do schema tv. Nenhum assinante dentro do módulo: quem consome (a Saúde) registra o seu.
        services.AddModuleOutbox<TvDbContext>(Name);
        services.AddIntegrationEvent<TvStateChanged>(TvStateChanged.EventType);
        services.AddIntegrationEvent<TvWatchdogRecorded>(TvWatchdogRecorded.EventType);

        // Em memória e atrás de portas, sempre como instância do contêiner (nada estático).
        services.AddSingleton<ITvStateStore, InMemoryTvStateStore>();
        services.AddSingleton<ITvAgentPresence, DevicesAgentPresence>();
        services.AddSingleton<IAgentPresenceListener, TvPresenceListener>();
        services.AddSingleton<ITvCommandSender, DevicesGatewayCommandSender>();
        services.AddSingleton<TvStatePersister>();
        services.AddSingleton<AuditRetention>();
        services.AddSingleton<TvStateProvider>();
        services.AddSingleton(sp => new SseBroadcaster<object>(sp.GetRequiredService<IOptions<TvModuleOptions>>().Value.Sse));
        services.AddSingleton<ITvStreamPublisher, TvStreamPublisher>();

        services.AddScoped<ITvCommandAudit, EfCommandAudit>();
        services.AddScoped<ITvShortcutReader, EfShortcutReader>();
        services.AddScoped<TvCommandRunner>();
        services.AddScoped<IAgentMessageHandler, TvAgentMessageHandler>();

        services.AddSingleton(new GetModuleInfoHandler(version));
        services.AddScoped<ITvModule, TvModuleApi>();
        services.AddScoped<GetStateHandler>();
        services.AddScoped<SendKeyHandler>();
        services.AddScoped<SendTextHandler>();
        services.AddScoped<PowerOffHandler>();
        services.AddScoped<LaunchShortcutHandler>();
        services.AddScoped<ListShortcutsHandler>();
        services.AddScoped<UpdateShortcutHandler>();
        services.AddScoped<RefreshShortcutsHandler>();
        services.AddScoped<WakeHandler>();
        services.AddScoped<RecentCommandsHandler>();
        services.AddScoped<StreamEventsHandler>();
        return services;
    }

    public static IEndpointRouteBuilder MapTvEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        // Sem AllowAnonymous no grupo: ele venceria a política de cada rota. A padrão é "autenticado" e a
        // única rota pública (/info) se declara sozinha.
        var group = endpoints.MapGroup($"/api/v1/{Name}");
        group.MapGetModuleInfo();
        group.MapGetState();
        group.MapSendKey();
        group.MapSendText();
        group.MapPowerOff();
        group.MapLaunchShortcut();
        group.MapListShortcuts();
        group.MapUpdateShortcut();
        group.MapRefreshShortcuts();
        group.MapWake();
        group.MapRecentCommands();
        group.MapStreamEvents();
        return endpoints;
    }
}
