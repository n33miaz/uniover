using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
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
using UniOver.Modules.Tv.Audit;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Features.Agents;
using UniOver.Modules.Tv.Features.Cleanup;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Config;
using UniOver.Modules.Tv.Features.Events;
using UniOver.Modules.Tv.Features.GetModuleInfo;
using UniOver.Modules.Tv.Features.GetState;
using UniOver.Modules.Tv.Features.LaunchShortcut;
using UniOver.Modules.Tv.Features.ListShortcuts;
using UniOver.Modules.Tv.Features.Layout;
using UniOver.Modules.Tv.Features.PowerOff;
using UniOver.Modules.Tv.Features.PowerSchedule;
using UniOver.Modules.Tv.Features.RecentCommands;
using UniOver.Modules.Tv.Features.RefreshShortcuts;
using UniOver.Modules.Tv.Features.ReorderShortcuts;
using UniOver.Modules.Tv.Features.SendKey;
using UniOver.Modules.Tv.Features.SendText;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Features.UpdateShortcut;
using UniOver.Modules.Tv.Features.Tvs;
using UniOver.Modules.Tv.Features.Wake;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel.Audit;
using UniOver.SharedKernel.Usage;

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

        // Cada rota da TV cita a política da sua permissão (catálogo do BuildingBlocks, lida do banco com cache curto); só o
        // fluxo ao vivo tem política própria, por causa do cookie de bilhete. A política por permissão já inclui o papel
        // conhecido e a conta ativa. As demais rotas da API ficam na política padrão, que é só do administrador.
        services.AddAuthorizationBuilder()
            .AddPolicy(TvAuth.StreamPolicy, policy => policy
                .AddAuthenticationSchemes(UniOverAuth.StreamScheme)
                .RequirePermission(AccessPermissions.TvModule)
                .RequireGetOnly());

        services.TryAddSingleton(TimeProvider.System);
        services.AddModuleDbContext<TvDbContext>(configuration, TvDbContext.SchemaName, typeof(TvDbContext).Assembly);

        // Eventos pela outbox do schema tv. Nenhum assinante dentro do módulo: quem consome (a Saúde) registra o seu.
        services.AddModuleOutbox<TvDbContext>(Name);
        services.AddIntegrationEvent<TvStateChanged>(TvStateChanged.EventType);
        services.AddIntegrationEvent<TvWatchdogRecorded>(TvWatchdogRecorded.EventType);

        // Em memória e atrás de portas, sempre como instância do contêiner (nada estático).
        services.AddSingleton<ITvStateStore, InMemoryTvStateStore>();

        // Qual agente controla a TV: a linha salva no app, depois a variável de ambiente (reserva), depois nenhum.
        services.AddSingleton<ISavedTvReader, EfSavedTvReader>();
        services.AddSingleton<ITvAgentResolver, TvAgentResolver>();
        services.AddSingleton<ITvAgentPresence, DevicesAgentPresence>();
        services.AddSingleton<IAgentPresenceListener, TvPresenceListener>();
        services.AddSingleton<ITvCommandSender, DevicesGatewayCommandSender>();
        services.AddSingleton<ITvCleanupReports, InMemoryTvCleanupReports>();
        services.AddSingleton<TvStatePersister>();
        services.AddScoped<TvStateProvider>();
        services.AddSingleton<TvStreamPublisher>();
        services.AddSingleton<ITvStreamPublisher>(sp => sp.GetRequiredService<TvStreamPublisher>());

        services.AddScoped<ITvCommandAudit, EfCommandAudit>();
        services.AddScoped<ITvCurrentSelection, TvCurrentSelection>();
        services.AddScoped<TvSelectionService>();

        // Auditoria: os comandos da TV são uma fonte da trilha do administrador. A retenção (30 dias) roda no banco; a aplicação só chama a função.
        services.AddScoped<IAuditSource, TvAuditSource>();
        services.AddScoped<IPersonUsageSource, TvUsageSource>();
        services.AddAuditPurge<TvDbContext>(configuration, TvDbContext.SchemaName, "purge_audit", AuditRetentionPolicy.CommandDays);
        services.AddScoped<ITvShortcutReader, EfShortcutReader>();
        services.AddScoped<TvCommandRunner>();
        services.AddScoped<IAgentMessageHandler, TvAgentMessageHandler>();

        services.AddSingleton(new GetModuleInfoHandler(version));
        services.AddScoped<ITvModule, TvModuleApi>();
        services.AddScoped<GetStateHandler>();
        services.AddScoped<SendKeyHandler>();
        services.AddScoped<SendTextHandler>();
        services.AddScoped<PowerOffHandler>();
        services.AddScoped<PowerScheduleHandler>();
        services.AddScoped<ScheduledPowerOffDispatcher>();
        services.AddHostedService<ScheduledPowerOffWorker>();
        services.AddScoped<LaunchShortcutHandler>();
        services.AddScoped<ListShortcutsHandler>();
        services.AddScoped<UpdateShortcutHandler>();
        services.AddScoped<ReorderShortcutsHandler>();
        services.AddScoped<RefreshShortcutsHandler>();
        services.AddScoped<WakeHandler>();
        services.AddScoped<CleanupHandler>();
        services.AddScoped<RecentCommandsHandler>();
        services.AddScoped<StreamEventsHandler>();
        services.AddScoped<TvConfigView>();
        services.AddScoped<GetConfigHandler>();
        services.AddScoped<BindAgentHandler>();
        services.AddScoped<ManageTvsHandler>();
        services.AddScoped<IPairedTvRegistrar, PairedTvRegistrar>();
        return services;
    }

    public static IEndpointRouteBuilder MapTvEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        // Sem AllowAnonymous no grupo: ele venceria a política de cada rota. A padrão é "autenticado" e a
        // única rota pública (/info) se declara sozinha.
        var group = endpoints.MapGroup($"/api/v1/{Name}").AddEndpointFilter(TvSelectionEndpointFilter.InvokeAsync);
        group.MapGetModuleInfo();
        group.MapGetState();
        group.MapSendKey();
        group.MapSendText();
        group.MapPowerOff();
        group.MapPowerSchedule();
        group.MapLaunchShortcut();
        group.MapListShortcuts();
        group.MapTvLayout();
        group.MapUpdateShortcut();
        group.MapReorderShortcuts();
        group.MapRefreshShortcuts();
        group.MapWake();
        group.MapCleanup();
        group.MapRecentCommands();
        group.MapStreamEvents();
        group.MapGetConfig();
        group.MapBindAgent();
        group.MapTvs();
        return endpoints;
    }
}
