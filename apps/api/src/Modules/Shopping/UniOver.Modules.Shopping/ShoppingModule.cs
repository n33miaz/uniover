using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Shopping.Audit;
using UniOver.Modules.Shopping.Features;
using UniOver.Modules.Shopping.Infrastructure;
using UniOver.Modules.Shopping.Persistence;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Shopping;

/// <summary>
/// Compras: grupo (com convites por link), produtos, lista da casa e idas ao mercado. O módulo não registra serviço de fundo nem temporizador
/// próprios, para o banco poder dormir (a limpeza da trilha entra na rodada diária que os outros módulos já têm). O
/// único trabalho fora do pedido é o que um pedido dispara: a leitura do Economize e a importação das compras de lá.
/// </summary>
public static class ShoppingModule
{
    public const string Name = "shopping";

    public static IServiceCollection AddShoppingModule(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.TryAddSingleton(TimeProvider.System);
        services.AddModuleDbContext<ShoppingDbContext>(configuration, ShoppingDbContext.SchemaName, typeof(ShoppingDbContext).Assembly);
        services.AddIdempotencyStore<ShoppingDbContext>();
        services.AddScoped<IIdempotencyGateway<ShoppingDbContext>, ShoppingIdempotencyGateway>();
        services.AddScoped<ShoppingGroupService>();
        services.AddScoped<ShoppingWriter>();

        // Economize: desligado por padrão, e o cliente confere de novo antes de cada pedido (sem chave, nada sai). Nada
        // roda sozinho: a leitura do conselho e a importação só nascem de um pedido de quem usa o app.
        services.AddOptions<ShoppingModuleOptions>()
            .Bind(configuration.GetSection(ShoppingModuleOptions.SectionName))
            .Validate(ShoppingModuleOptions.IsValid, "Modules:Shopping:Economize ligado precisa de BaseUrl https (sem usuário nem consulta) e de ApiKey no formato eco_...")
            .ValidateOnStart();
        // O ritmo de 60 pedidos/min é por processo: vale porque a API roda numa instância (ver EconomizeThrottle).
        services.AddSingleton<EconomizeThrottle>();
        services.AddHttpClient<IEconomizeClient, HttpEconomizeClient>(HttpEconomizeClient.Name, client => client.Timeout = HttpEconomizeClient.Timeout)
            // O endereço é só o da configuração: um redirecionamento não leva o pedido para outro lugar.
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false })
            .RedactLoggedHeaders(_ => true);
        services.AddSingleton<EconomizeAdviceCache>();
        services.AddScoped<EconomizeImportRunner>();
        services.AddSingleton<EconomizeImportQueue>();

        // Auditoria: quem entrou e quem saiu de um grupo é uma fonte da trilha do administrador. A retenção roda no
        // banco; a aplicação só chama a função, pelo serviço de limpeza que já existe (uma vez por dia, para todos os módulos).
        services.AddScoped<IAuditSource, ShoppingAuditSource>();
        services.AddAuditPurge<ShoppingDbContext>(configuration, ShoppingDbContext.SchemaName, "purge_audit", AuditRetentionPolicy.SecurityDays);
        services.AddShoppingInviteCleanup();
        return services;
    }

    public static IEndpointRouteBuilder MapShoppingEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup($"/api/v1/{Name}");
        group.MapShoppingReads();
        group.MapShoppingWrites();
        group.MapEconomizeIntegration();
        group.MapShoppingInvites();
        return endpoints;
    }
}

internal static class ShoppingAuth
{
    /// <summary>Toda rota do módulo exige <c>module:shopping</c>; o grupo de quem chama delimita o que ela alcança.</summary>
    internal static readonly string Module = AccessPermissions.Policy(AccessPermissions.ShoppingModule);
}
