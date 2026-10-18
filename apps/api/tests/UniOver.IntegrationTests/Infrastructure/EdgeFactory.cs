using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.TestModule;

namespace UniOver.IntegrationTests.Infrastructure;

/// <summary>
/// Host real com ambiente e configuração controlados pelo teste. Opcionalmente injeta endpoints de teste
/// (por IStartupFilter) e registra o módulo de teste com o banco, sem tocar no Host.
/// </summary>
public sealed class EdgeFactory(
    string environment = "Development",
    IReadOnlyDictionary<string, string?>? settings = null,
    bool withTestEndpoints = false,
    bool withTestModule = false) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(environment);
        foreach (var (key, value) in settings ?? new Dictionary<string, string?>())
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureServices((context, services) =>
        {
            if (withTestEndpoints)
            {
                services.AddSingleton<IStartupFilter, TestEndpointsFilter>();
            }

            if (withTestModule)
            {
                services.AddModuleDbContext<TestModuleDbContext>(
                    context.Configuration, TestModuleDbContext.SchemaName, typeof(TestModuleDbContext).Assembly);
            }
        });
    }

    /// <summary>
    /// Mapeia rotas de teste no mesmo construtor de endpoints do Host: depois do pipeline montado, o
    /// WebApplication deixa o construtor de rotas nas propriedades do IApplicationBuilder.
    /// </summary>
    private sealed class TestEndpointsFilter : IStartupFilter
    {
        private const string RouteBuilderKey = "__EndpointRouteBuilder";

        private static IResult Boom() => throw new InvalidOperationException("detalhe-interno-secreto");

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            next(app);

            var routes = (IEndpointRouteBuilder)app.Properties[RouteBuilderKey]!;
            routes.MapGet("/api/test/login", () => Results.Ok("ok"))
                .AllowAnonymous()
                .RequireRateLimiting(RateLimitPolicies.Login);
            routes.MapGet("/api/test/validation", () => ProblemDetailsExtensions.ValidationProblem(
                new Dictionary<string, string[]> { ["email"] = ["Informe um e-mail válido."] })).AllowAnonymous();
            routes.MapGet("/api/test/boom", Boom).AllowAnonymous();
        };
    }
}
