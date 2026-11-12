using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Shopping.Audit;
using UniOver.Modules.Shopping.Features;
using UniOver.Modules.Shopping.Persistence;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Shopping;

/// <summary>
/// Compras: grupo, produtos, lista da casa e idas ao mercado. Tudo acontece dentro de um pedido HTTP: o módulo não
/// registra serviço de fundo nem temporizador próprios, para o banco poder dormir (a limpeza da trilha entra na
/// rodada diária que os outros módulos já têm).
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

        // Auditoria: quem entrou e quem saiu de um grupo é uma fonte da trilha do administrador. A retenção roda no
        // banco; a aplicação só chama a função, pelo serviço de limpeza que já existe (uma vez por dia, para todos os módulos).
        services.AddScoped<IAuditSource, ShoppingAuditSource>();
        services.AddAuditPurge<ShoppingDbContext>(configuration, ShoppingDbContext.SchemaName, "purge_audit", AuditRetentionPolicy.SecurityDays);
        return services;
    }

    public static IEndpointRouteBuilder MapShoppingEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup($"/api/v1/{Name}");
        group.MapShoppingReads();
        group.MapShoppingWrites();
        return endpoints;
    }
}

internal static class ShoppingAuth
{
    /// <summary>Toda rota do módulo exige <c>module:shopping</c>; o grupo de quem chama delimita o que ela alcança.</summary>
    internal static readonly string Module = AccessPermissions.Policy(AccessPermissions.ShoppingModule);
}
