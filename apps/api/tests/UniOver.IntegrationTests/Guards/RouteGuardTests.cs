using System.Text;
using System.Net;
using AwesomeAssertions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Guards;

/// <summary>
/// Varredura de todas as rotas da API. Vale para todo módulo futuro sem editar o teste: as rotas vêm do
/// <see cref="EndpointDataSource"/> do Host real; só as rotas públicas novas precisam entrar em
/// <see cref="PublicRoutes"/>.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class RouteGuardTests(PostgresFixture postgres)
{
    /// <summary>Rotas sensíveis e o limite que cada uma deve declarar. Acrescentar junto com a rota nova.</summary>
    private static readonly (string Method, string Pattern, string Policy)[] RateLimited =
    [
        ("POST", "/api/v1/identity/auth/login", RateLimitPolicies.Login),
        ("POST", "/api/v1/identity/auth/refresh", RateLimitPolicies.Refresh),
        ("POST", "/api/v1/identity/passkeys/registration/options", RateLimitPolicies.Login),
        ("POST", "/api/v1/identity/passkeys/registration/complete", RateLimitPolicies.Login),
        ("POST", "/api/v1/identity/step-up/options", RateLimitPolicies.Login),
        ("POST", "/api/v1/identity/step-up/complete", RateLimitPolicies.Login),

        // Pareamento de aparelhos: qualquer rota sob o prefixo (o '*' final significa "começa com").
        ("*", "/api/v1/devices/pairing/*", RateLimitPolicies.Pairing),
    ];

    /// <summary>Production é o que vai para o ar; Development acrescenta o OpenAPI e também não pode vazar rota.</summary>
    public static TheoryData<string> Environments => ["Production", "Development"];

    private Task<EdgeFactory> StartAsync(string environment) => GuardHost.StartAsync(postgres, environment);

    private static List<RouteEndpoint> RoutesOf(EdgeFactory factory) =>
        [.. factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()];

    private static void PrintInventory(IEnumerable<RouteEndpoint> routes, string environment)
    {
        var output = TestContext.Current.TestOutputHelper;
        output?.WriteLine($"Inventário de rotas ({environment}):");
        foreach (var route in routes.OrderBy(r => RouteInspector.Pattern(r), StringComparer.Ordinal))
        {
            var kind = RouteInspector.Classify(route) switch
            {
                RouteKind.Public => "pública",
                RouteKind.StepUp => "step-up",
                RouteKind.Stream => "stream",
                _ => "protegida",
            };
            var limit = RouteInspector.RateLimitPolicy(route) ?? "-";
            output?.WriteLine($"  {RouteInspector.Describe(route),-62} módulo={RouteInspector.Module(RouteInspector.Pattern(route)),-9} {kind,-10} limite={limit}");
        }
    }

    [Theory]
    [MemberData(nameof(Environments))]
    public async Task EveryRoute_HasExplicitPolicyOrIsListedPublic(string environment)
    {
        await using var factory = await StartAsync(environment);
        var routes = RoutesOf(factory);
        PrintInventory(routes, environment);

        routes.Should().NotBeEmpty("sem rotas a varredura não provaria nada");
        RouteInspector.Violations(routes).Should().BeEmpty("toda rota declara a sua política ou está na lista de públicas");
    }

    [Theory]
    [MemberData(nameof(Environments))]
    public async Task AnonymousRequest_ToEveryNonPublicRoute_Returns401(string environment)
    {
        await using var factory = await StartAsync(environment);
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"),
            HandleCookies = false,
            AllowAutoRedirect = false,
        });

        var failures = new List<string>();
        var checkedRoutes = 0;
        foreach (var route in RoutesOf(factory).Where(r => RouteInspector.Classify(r) != RouteKind.Public))
        {
            var methods = RouteInspector.Methods(route);
            var method = methods.Count == 0 ? HttpMethod.Get : new HttpMethod(methods[0]);
            var url = RouteInspector.FillSample(RouteInspector.Pattern(route));

            using var request = new HttpRequestMessage(method, url);
            request.Headers.Add(IdentityApp.ClientHeader, "web");

            // Rotas com corpo JSON só casam no roteador quando o pedido declara o tipo do conteúdo; sem ele o
            // roteador cai no 404 genérico de /api e a rota real nem seria exercitada.
            if (method != HttpMethod.Get && method != HttpMethod.Delete && method != HttpMethod.Head)
            {
                request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
            }

            using var response = await client.SendAsync(request, TestContext.Current.CancellationToken);
            checkedRoutes++;

            if (response.StatusCode != HttpStatusCode.Unauthorized)
            {
                failures.Add($"{RouteInspector.Describe(route)} respondeu {(int)response.StatusCode} sem credencial (esperado 401)");
            }
        }

        checkedRoutes.Should().BeGreaterThan(0, "o Host precisa ter ao menos uma rota protegida");
        failures.Should().BeEmpty();
    }

    [Theory]
    [MemberData(nameof(Environments))]
    public async Task SensitiveRoutes_DeclareTheirRateLimitPolicy(string environment)
    {
        await using var factory = await StartAsync(environment);
        var routes = RoutesOf(factory);

        var failures = new List<string>();
        foreach (var (method, pattern, policy) in RateLimited)
        {
            var matching = routes.Where(r =>
                (pattern.EndsWith('*')
                    ? RouteInspector.Pattern(r).StartsWith(pattern[..^1], StringComparison.Ordinal)
                    : RouteInspector.Pattern(r) == pattern)
                && (method == "*" || RouteInspector.Methods(r).Contains(method, StringComparer.OrdinalIgnoreCase)));

            // Rota que ainda não existe não falha: a tabela é acrescida junto com a rota.
            foreach (var route in matching)
            {
                var declared = RouteInspector.RateLimitPolicy(route);
                if (declared != policy)
                {
                    failures.Add($"{RouteInspector.Describe(route)} declara limite '{declared ?? "nenhum"}' (esperado '{policy}')");
                }
            }
        }

        failures.Should().BeEmpty();
    }

    // Prova de que a varredura morde: rotas montadas à mão, cada uma violando uma parte da regra.

    private static RouteEndpoint Endpoint(string pattern, params object[] metadata) =>
        new(_ => Task.CompletedTask, RoutePatternFactory.Parse(pattern), 0, new EndpointMetadataCollection(metadata), pattern);

    private sealed class Authorize : IAuthorizeData
    {
        public string? Policy { get; set; }

        public string? Roles { get; set; }

        public string? AuthenticationSchemes { get; set; }
    }

    private sealed class Anonymous : IAllowAnonymous;

    [Fact]
    public void Scan_RejectsRouteWithoutExplicitPolicy()
    {
        var route = Endpoint("/api/v1/novo/segredo", new HttpMethodMetadata(["GET"]));

        RouteInspector.Violations([route]).Should().ContainSingle()
            .Which.Should().Contain("rota GET /api/v1/novo/segredo (módulo novo) sem política explícita e fora da lista de públicas");
    }

    [Fact]
    public void Scan_RejectsAnonymousRouteOutsideTheList()
    {
        var route = Endpoint("/api/v1/novo/aberta", new HttpMethodMetadata(["GET"]), new Anonymous());

        RouteInspector.Violations([route]).Should().ContainSingle().Which.Should().Contain("anônima e está fora da lista");
    }

    [Fact]
    public void Scan_RejectsListedRouteThatDoesNotAllowAnonymous()
    {
        var route = Endpoint("/api/v1/identity/info", new HttpMethodMetadata(["GET"]), new Authorize());

        RouteInspector.Violations([route]).Should().ContainSingle().Which.Should().Contain("não declara AllowAnonymous");
    }

    [Fact]
    public void Scan_RejectsUnlistedMethodOnAListedPattern()
    {
        // O GET está na lista; um POST anônimo no mesmo caminho não está.
        var route = Endpoint("/api/v1/identity/info", new HttpMethodMetadata(["POST"]), new Anonymous());

        RouteInspector.Violations([route]).Should().ContainSingle().Which.Should().Contain("fora da lista de públicas");
    }

    [Fact]
    public void Scan_AcceptsExplicitPolicyAndListedPublicRoute()
    {
        var protectedRoute = Endpoint("/api/v1/novo/dado", new HttpMethodMetadata(["GET"]), new Authorize());
        var publicRoute = Endpoint("/api/v1/identity/info", new HttpMethodMetadata(["GET"]), new Anonymous());

        RouteInspector.Violations([protectedRoute, publicRoute]).Should().BeEmpty();
    }

    [Fact]
    public void FillSample_ProducesRequestablePaths()
    {
        RouteInspector.FillSample("/api/v1/identity/passkeys/{id:guid}").Should().MatchRegex("^/api/v1/identity/passkeys/[0-9a-f-]{36}$");
        RouteInspector.FillSample("/api/v1/x/{name}/y/{n:int}").Should().Be("/api/v1/x/sample/y/1");
        RouteInspector.FillSample("/api/{**path}").Should().Be("/api/sample/path");
    }
}
