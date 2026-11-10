using System.Net;
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
    bool withTestModule = false,
    string? webRoot = null,
    string? peerAddress = null) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(environment);
        if (webRoot is not null)
        {
            builder.UseWebRoot(webRoot);
        }

        foreach (var (key, value) in settings ?? new Dictionary<string, string?>())
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureServices((context, services) =>
        {
            if (withTestEndpoints)
            {
                services.AddSingleton(new TestPeer(peerAddress));
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
    /// <summary>O endereço de quem abriu a conexão com o app (o salto do proxy); sem ele o servidor de teste não informa nenhum.</summary>
    private sealed record TestPeer(string? Address);

    private sealed class TestEndpointsFilter(TestPeer peer) : IStartupFilter
    {
        private const string RouteBuilderKey = "__EndpointRouteBuilder";

        private sealed record TestBody(string? Name);

        private static IResult Boom() => throw new InvalidOperationException("detalhe-interno-secreto");

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            // Antes de todo o pipeline do Host: é o que o Kestrel preencheria ao aceitar a conexão.
            if (peer.Address is not null)
            {
                var address = IPAddress.Parse(peer.Address);
                app.Use((context, forward) =>
                {
                    context.Connection.RemoteIpAddress = address;
                    return forward(context);
                });
            }

            next(app);

            var routes = (IEndpointRouteBuilder)app.Properties[RouteBuilderKey]!;
            routes.MapGet("/api/test/login", () => Results.Ok("ok"))
                .AllowAnonymous()
                .RequireRateLimiting(RateLimitPolicies.Login);
            routes.MapGet("/api/test/client-ip", (HttpContext context) => Results.Ok(context.Connection.RemoteIpAddress?.ToString()))
                .AllowAnonymous();
            routes.MapGet("/api/test/validation", () => ProblemDetailsExtensions.ValidationProblem(
                new Dictionary<string, string[]> { ["email"] = ["Informe um e-mail válido."] })).AllowAnonymous();
            routes.MapGet("/api/test/boom", Boom).AllowAnonymous();
            routes.MapGet("/api/test/slow", async () =>
            {
                await Task.Delay(250);
                return Results.Ok("ok");
            }).AllowAnonymous();
            routes.MapPost("/api/test/optional-body", (TestBody? body) => Results.Ok(new { received = body is not null })).AllowAnonymous();
            routes.MapPost("/api/test/required-body", (TestBody body) => Results.Ok(new { received = body.Name })).AllowAnonymous();
        };
    }
}
