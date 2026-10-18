using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Identity.Bootstrap;
using UniOver.Modules.Identity.Features.BeginPasskeyRegistration;
using UniOver.Modules.Identity.Features.CompletePasskeyRegistration;
using UniOver.Modules.Identity.Features.ConfirmStepUp;
using UniOver.Modules.Identity.Features.GetMe;
using UniOver.Modules.Identity.Features.GetModuleInfo;
using UniOver.Modules.Identity.Features.ListPasskeys;
using UniOver.Modules.Identity.Features.Login;
using UniOver.Modules.Identity.Features.Logout;
using UniOver.Modules.Identity.Features.Refresh;
using UniOver.Modules.Identity.Features.RemovePasskey;
using UniOver.Modules.Identity.Features.RenamePasskey;
using UniOver.Modules.Identity.Features.RequestStepUp;
using UniOver.Modules.Identity.Features.StreamTicket;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;
using UniOver.Modules.Tv.Contracts;

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

        services.AddSingleton<PasswordService>();
        services.AddSingleton<AccessTokenIssuer>();
        services.AddSingleton<AuthCookieWriter>();
        services.AddScoped<LoginAuditWriter>();

        services.AddScoped<LoginHandler>();
        services.AddScoped<RefreshHandler>();
        services.AddScoped<LogoutHandler>();
        services.AddScoped<StreamTicketHandler>();
        services.AddScoped<GetMeHandler>();
        services.AddScoped(sp => new GetModuleInfoHandler(version, sp.GetRequiredService<ITvModule>()));

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
        group.MapStreamTicket();
        group.MapGetMe();
        group.MapBeginPasskeyRegistration();
        group.MapCompletePasskeyRegistration();
        group.MapListPasskeys();
        group.MapRenamePasskey();
        group.MapRemovePasskey();
        group.MapRequestStepUp();
        group.MapConfirmStepUp();
        return endpoints;
    }
}
