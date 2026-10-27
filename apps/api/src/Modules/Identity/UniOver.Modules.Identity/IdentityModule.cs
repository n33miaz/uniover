using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Adapters;
using UniOver.Modules.Identity.Audit;
using UniOver.Modules.Identity.Bootstrap;
using UniOver.Modules.Identity.Features.AcceptGuestInvite;
using UniOver.Modules.Identity.Features.BeginPasskeyRegistration;
using UniOver.Modules.Identity.Features.CompletePasskeyRegistration;
using UniOver.Modules.Identity.Features.ConfirmStepUp;
using UniOver.Modules.Identity.Features.ConfirmStepUpWithPassword;
using UniOver.Modules.Identity.Features.CreateGuestInvite;
using UniOver.Modules.Identity.Features.GetMe;
using UniOver.Modules.Identity.Features.GetModuleInfo;
using UniOver.Modules.Identity.Features.ListAudit;
using UniOver.Modules.Identity.Features.ListGuestInvites;
using UniOver.Modules.Identity.Features.ListGuests;
using UniOver.Modules.Identity.Features.ListPasskeys;
using UniOver.Modules.Identity.Features.Login;
using UniOver.Modules.Identity.Features.Logout;
using UniOver.Modules.Identity.Features.QrLogin;
using UniOver.Modules.Identity.Features.Refresh;
using UniOver.Modules.Identity.Features.RemovePasskey;
using UniOver.Modules.Identity.Features.RevokeGuest;
using UniOver.Modules.Identity.Features.RevokeGuestInvite;
using UniOver.Modules.Identity.Features.Sessions;
using UniOver.Modules.Identity.Features.RenamePasskey;
using UniOver.Modules.Identity.Features.RequestStepUp;
using UniOver.Modules.Identity.Features.SetGuestPermissions;
using UniOver.Modules.Identity.Features.StreamTicket;
using UniOver.Modules.Identity.Features.SystemSettings;
using UniOver.Modules.Identity.Features.UpdateProfile;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;
using UniOver.Modules.Tv.Contracts;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Identity;

public static class IdentityModule
{
    public const string Name = "identity";

    public static IServiceCollection AddIdentityModule(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        var version = configuration.GetSection(IdentityModuleOptions.SectionName)["Version"] ?? "0.0.0";

        services.AddOptions<IdentityModuleOptions>()
            .Bind(configuration.GetSection(IdentityModuleOptions.SectionName))
            .Validate(IdentityModuleOptions.IsValid, "Modules:Identity tem valor fora do permitido (tempos e limites devem ser positivos).")
            .ValidateOnStart();

        services.TryAddSingleton(TimeProvider.System);
        services.AddModuleDbContext<IdentityDbContext>(
            configuration, IdentityDbContext.SchemaName, typeof(IdentityDbContext).Assembly);

        // Cada escrita reenviável usa uma chave no schema identity; a ponte mantém o filtro HTTP sem referência ao EF.
        services.AddIdempotencyStore<IdentityDbContext>();
        services.AddScoped<IIdempotencyGateway<IdentityDbContext>, IdentityIdempotencyGateway>();

        services.AddSingleton<PasswordService>();
        services.AddSingleton<AccessTokenIssuer>();
        services.AddSingleton<AuthCookieWriter>();
        services.AddScoped<LoginAuditWriter>();
        services.AddSingleton<SystemSettingsService>();
        services.AddSingleton<UniOver.Modules.Identity.Contracts.ISystemSettings>(sp => sp.GetRequiredService<SystemSettingsService>());

        // Auditoria: a trilha de login é uma fonte (cada módulo com tabela de auditoria registra a sua) e este módulo junta
        // todas para o administrador. A retenção roda no banco; a aplicação só chama a função, periodicamente.
        services.AddScoped<IAuditSource, IdentityAuditSource>();
        services.AddScoped<AuditReader>();
        services.AddAuditPurge<IdentityDbContext>(
            configuration, IdentityDbContext.SchemaName, "purge_audit", AuditRetentionPolicy.SecurityDays);

        services.AddScoped<LoginHandler>();
        services.AddScoped<RefreshHandler>();
        services.AddScoped<LogoutHandler>();
        services.AddScoped<StartQrLoginHandler>();
        services.AddScoped<PollQrLoginHandler>();
        services.AddScoped<QrLoginDecisionHandler>();
        services.AddScoped<StreamTicketHandler>();
        services.AddScoped<GetMeHandler>();
        services.AddScoped<CreateGuestInviteHandler>();
        services.AddScoped<ListGuestInvitesHandler>();
        services.AddScoped<RevokeGuestInviteHandler>();
        services.AddScoped<AcceptGuestInviteHandler>();
        services.AddScoped<ListGuestsHandler>();
        services.AddScoped<RevokeGuestHandler>();
        services.AddScoped<SetGuestPermissionsHandler>();
        services.AddScoped<UpdateProfileHandler>();
        services.AddScoped<SessionHandler>();

        // Revogação imediata na TV: o status do convidado (cache curto) é uma porta usada pelas políticas dos módulos.
        services.AddSingleton<GuestAccountStatus>();
        services.AddSingleton<IAccountStatus>(sp => sp.GetRequiredService<GuestAccountStatus>());

        // O que cada conta pode fazer: lido do banco (nunca do JWT), com cache de 30 s e invalidação ao mudar ou revogar.
        services.AddSingleton<AccessGrantsService>();
        services.AddSingleton<IAccessGrants>(sp => sp.GetRequiredService<AccessGrantsService>());
        services.AddScoped(sp => new GetModuleInfoHandler(version, sp.GetRequiredService<ITvModule>()));

        // Sair, "quem sou" e o bilhete de stream valem para o dono e para o convidado; o resto do módulo é só do dono.
        // Escrever no próprio perfil também é dos dois, mas só de convidado ativo (revogado não escreve mais nada).
        services.AddAuthorizationBuilder()
            .AddPolicy(
                IdentityAuth.AccountSessionPolicy,
                policy => policy.RequireAccountRole(AccountRoles.Owner, AccountRoles.Guest))
            .AddPolicy(
                IdentityAuth.ActiveAccountSessionPolicy,
                policy => policy.RequireAccountRole(AccountRoles.Owner, AccountRoles.Guest).RequireActiveAccount());

        // Singleton pelo tipo concreto também, para os testes esperarem o fim do seed sem adivinhar o tempo.
        services.AddSingleton<OwnerBootstrapService>();
        services.AddSingleton<IHostedService>(sp => sp.GetRequiredService<OwnerBootstrapService>());
        return services;
    }

    public static IEndpointRouteBuilder MapIdentityEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        // Sem AllowAnonymous no grupo: a política padrão é "autenticado" e cada rota pública se declara.
        var group = endpoints.MapGroup($"/api/v1/{Name}");
        group.MapGetModuleInfo();
        group.MapLogin();
        group.MapRefresh();
        group.MapLogout();
        group.MapStartQrLogin();
        group.MapPollQrLogin();
        group.MapQrLoginDecisions();
        group.MapStreamTicket();
        group.MapGetMe();
        group.MapUpdateProfile();
        group.MapListAudit();
        group.MapCreateGuestInvite();
        group.MapListGuestInvites();
        group.MapRevokeGuestInvite();
        group.MapAcceptGuestInvite();
        group.MapListGuests();
        group.MapRevokeGuest();
        group.MapSetGuestPermissions();
        group.MapSystemSettings();
        group.MapSessions();
        group.MapBeginPasskeyRegistration();
        group.MapCompletePasskeyRegistration();
        group.MapListPasskeys();
        group.MapRenamePasskey();
        group.MapRemovePasskey();
        group.MapRequestStepUp();
        group.MapConfirmStepUp();
        group.MapConfirmStepUpWithPassword();
        return endpoints;
    }
}
