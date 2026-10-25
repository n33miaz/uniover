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
using UniOver.IntegrationTests.Training;
using UniOver.IntegrationTests.Tv;

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
        ("POST", "/api/v1/identity/step-up/password", RateLimitPolicies.Login),
        ("POST", "/api/v1/identity/guest-invites", RateLimitPolicies.Login),
        ("POST", "/api/v1/identity/guest-invites/accept", RateLimitPolicies.GuestInvite),
        ("PUT", "/api/v1/identity/guests/{id:guid}/permissions", RateLimitPolicies.Login),
        ("PATCH", "/api/v1/identity/me", RateLimitPolicies.Profile),

        // Entrada pelo QR: abrir e consultar são anônimos (um balde por IP cada); ver, confirmar e recusar são por conta.
        ("POST", "/api/v1/identity/auth/qr/start", RateLimitPolicies.QrStart),
        ("POST", "/api/v1/identity/auth/qr/poll", RateLimitPolicies.QrPoll),
        ("POST", "/api/v1/identity/auth/qr/info", RateLimitPolicies.QrDecide),
        ("POST", "/api/v1/identity/auth/qr/approve", RateLimitPolicies.QrDecide),
        ("POST", "/api/v1/identity/auth/qr/deny", RateLimitPolicies.QrDecide),

        // Pareamento de aparelhos: qualquer rota sob o prefixo (o '*' final significa "começa com").
        ("*", "/api/v1/devices/pairing/*", RateLimitPolicies.Pairing),

        // Canal do agente: cada abertura valida o token de dispositivo, então o limite segura tentativas em massa.
        ("GET", "/api/v1/devices/agents/{agentId}/ws", RateLimitPolicies.Pairing),

        // Manutenção remota de um agente (ver o registro, atualizar, reiniciar): limite por conta, baixo.
        ("POST", "/api/v1/devices/agents/{id:guid}/logs", RateLimitPolicies.Maintenance),
        ("POST", "/api/v1/devices/agents/{id:guid}/maintenance", RateLimitPolicies.Maintenance),

        // Comandos da TV: segurar uma tecla repete várias vezes por segundo, então o limite é por usuário e alto.
        ("POST", "/api/v1/tv/keys", RateLimitPolicies.Commands),
        ("POST", "/api/v1/tv/text", RateLimitPolicies.Commands),
        ("POST", "/api/v1/tv/power/off", RateLimitPolicies.Commands),
        ("POST", "/api/v1/tv/wake", RateLimitPolicies.Commands),
        ("POST", "/api/v1/tv/shortcuts/refresh", RateLimitPolicies.Commands),
        ("POST", "/api/v1/tv/cleanup", RateLimitPolicies.Commands),
        ("POST", "/api/v1/tv/shortcuts/{id:guid}/launch", RateLimitPolicies.Commands),
        ("PUT", "/api/v1/tv/shortcuts/order", RateLimitPolicies.Commands),

        // Trocar o computador que controla a TV: ação rara de administrador, com o mesmo limite baixo das outras que pedem passkey.
        ("PUT", "/api/v1/tv/config/agent", RateLimitPolicies.Login),
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

            // Sem corpo e sem Content-Type de propósito: a rota real tem de responder 401 (e não cair no 404 do
            // fallback de /api), então a autenticação vem antes de qualquer leitura de corpo.
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

    // A TV: cada rota declara a permissão da tabela (rota -> permissão), e a varredura morde quando não declara.

    [Theory]
    [MemberData(nameof(Environments))]
    public async Task EveryTvRoute_DeclaresItsPermission_AsInTheMap(string environment)
    {
        await using var factory = await StartAsync(environment);
        var routes = RoutesOf(factory);
        var policies = factory.Services.GetRequiredService<IAuthorizationPolicyProvider>();

        routes.Count(r => RouteInspector.Pattern(r).StartsWith("/api/v1/tv/", StringComparison.Ordinal))
            .Should().BeGreaterThan(TvPermissionMap.Routes.Count, "a varredura precisa ter visto as rotas da TV (e a pública /info)");
        (await TvPermissionMap.ViolationsAsync(routes, policies)).Should().BeEmpty(
            "toda rota da TV cita a política da sua permissão e está na tabela, e nenhuma rota de outro módulo carrega permissão da TV");
    }

    /// <summary>As políticas por permissão do catálogo, como o Host as registra, para avaliar rotas montadas à mão.</summary>
    private static DefaultAuthorizationPolicyProvider PermissionPolicies()
    {
        var options = new AuthorizationOptions();
        foreach (var permission in AccessPermissions.All)
        {
            var captured = permission;
            options.AddPolicy(AccessPermissions.Policy(captured), policy => policy.RequirePermission(captured));
        }

        options.AddPolicy(UniOverAuth.OwnerPolicy, policy => policy.RequireAccountRole(AccountRoles.Owner));

        // A política de confirmação com a passkey, como o Identity a monta: papel de administrador mais a confirmação da ação.
        options.AddPolicy(
            StepUp.Policy("tv.bind-agent"),
            policy => policy.RequireAccountRole(AccountRoles.Owner).AddRequirements(new StepUpRequirement("tv.bind-agent")));
        return new DefaultAuthorizationPolicyProvider(Microsoft.Extensions.Options.Options.Create(options));
    }

    private static Task<List<string>> TvViolationsOfAsync(RouteEndpoint route) =>
        TvPermissionMap.ViolationsAsync([route], PermissionPolicies());

    [Fact]
    public async Task TvScan_RejectsATvRouteOnTheOwnerOnlyDefault_WhichWouldHideItFromTheTable()
    {
        var route = Endpoint("/api/v1/tv/keys", new HttpMethodMetadata(["POST"]), new Authorize { Policy = UniOverAuth.OwnerPolicy });

        (await TvViolationsOfAsync(route)).Should().Contain(v => v.StartsWith("POST /api/v1/tv/keys:", StringComparison.Ordinal) && v.Contains("tv:control", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TvScan_RejectsATvRouteThatDeclaresAnotherPermission()
    {
        var route = Endpoint(
            "/api/v1/tv/keys", new HttpMethodMetadata(["POST"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TvPower) });

        (await TvViolationsOfAsync(route)).Should().Contain(v => v.Contains("declara [tv:power]", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TvScan_RejectsANewTvRouteThatIsNotInTheTable()
    {
        var route = Endpoint(
            "/api/v1/tv/novidade", new HttpMethodMetadata(["POST"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TvControl) });

        (await TvViolationsOfAsync(route)).Should().Contain(v => v.Contains("POST /api/v1/tv/novidade", StringComparison.Ordinal) && v.Contains("fora do mapa", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TvScan_RejectsATvPermissionOnARouteOutsideTheTv()
    {
        var route = Endpoint(
            "/api/v1/training/exercises", new HttpMethodMetadata(["GET"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TvControl) });

        (await TvViolationsOfAsync(route)).Should().Contain(v => v.Contains("rota fora da TV com a permissão da TV 'tv:control'", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TvScan_AcceptsARouteThatDeclaresExactlyThePermissionOfItsLine()
    {
        var route = Endpoint(
            "/api/v1/tv/keys", new HttpMethodMetadata(["POST"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TvControl) });

        // As demais linhas da tabela ficam sem rota (só há uma montada), mas a rota certa não gera nenhuma violação própria.
        (await TvViolationsOfAsync(route)).Should().NotContain(v => v.StartsWith("POST /api/v1/tv/keys:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TvScan_AcceptsTheAdminRoutesDeclaredAsTheTableSays()
    {
        var read = Endpoint("/api/v1/tv/config", new HttpMethodMetadata(["GET"]), new Authorize { Policy = UniOverAuth.OwnerPolicy });
        var write = Endpoint(
            "/api/v1/tv/config/agent", new HttpMethodMetadata(["PUT"]), new Authorize { Policy = StepUp.Policy("tv.bind-agent") });

        (await TvViolationsOfAsync(read)).Should().NotContain(v => v.StartsWith("GET /api/v1/tv/config:", StringComparison.Ordinal));
        (await TvViolationsOfAsync(write)).Should().NotContain(v => v.StartsWith("PUT /api/v1/tv/config/agent:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TvScan_RejectsAnAdminRouteThatIsOpenToTheGuest_ByTvPermission()
    {
        var route = Endpoint(
            "/api/v1/tv/config", new HttpMethodMetadata(["GET"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TvModule) });

        var violations = await TvViolationsOfAsync(route);

        violations.Should().Contain(v => v.StartsWith("GET /api/v1/tv/config:", StringComparison.Ordinal) && v.Contains("permissão [module:tv]", StringComparison.Ordinal));
        violations.Should().Contain(v => v.StartsWith("GET /api/v1/tv/config:", StringComparison.Ordinal) && v.Contains("exatamente administrador", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TvScan_RejectsTheAgentSwitchWithoutThePasskeyConfirmation()
    {
        var route = Endpoint(
            "/api/v1/tv/config/agent", new HttpMethodMetadata(["PUT"]), new Authorize { Policy = UniOverAuth.OwnerPolicy });

        (await TvViolationsOfAsync(route)).Should().Contain(v =>
            v.StartsWith("PUT /api/v1/tv/config/agent:", StringComparison.Ordinal) && v.Contains("'tv.bind-agent'", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TvScan_RejectsAnAdminReadThatAsksForAConfirmationItsLineDoesNotHave()
    {
        var route = Endpoint(
            "/api/v1/tv/config", new HttpMethodMetadata(["GET"]), new Authorize { Policy = StepUp.Policy("tv.bind-agent") });

        (await TvViolationsOfAsync(route)).Should().Contain(v =>
            v.StartsWith("GET /api/v1/tv/config:", StringComparison.Ordinal) && v.Contains("deveria ser nenhuma", StringComparison.Ordinal));
    }

    // O Treino: cada rota declara uma política NOMEADA e a permissão da tabela (rota -> permissão); a varredura morde quando não.

    [Theory]
    [MemberData(nameof(Environments))]
    public async Task EveryTrainingRoute_DeclaresANamedPolicyAndItsPermission_AsInTheMap(string environment)
    {
        await using var factory = await StartAsync(environment);
        var routes = RoutesOf(factory);
        var policies = factory.Services.GetRequiredService<IAuthorizationPolicyProvider>();

        routes.Count(r => RouteInspector.Pattern(r).StartsWith("/api/v1/training/", StringComparison.Ordinal))
            .Should().BeGreaterThanOrEqualTo(TrainingPermissionMap.Routes.Count + TrainingPermissionMap.AdminRoutes.Count, "a varredura precisa ter visto as 14 rotas do Treino");
        (await TrainingPermissionMap.ViolationsAsync(routes, policies)).Should().BeEmpty(
            "toda rota do Treino cita uma política nomeada, com a permissão da sua linha (ou a do dono, na importação), e nenhuma rota de outro módulo carrega a permissão do Treino");
    }

    private static Task<List<string>> TrainingViolationsOfAsync(params RouteEndpoint[] routes) =>
        TrainingPermissionMap.ViolationsAsync(routes, PermissionPolicies());

    [Fact]
    public async Task TrainingScan_RejectsATrainingRouteWithABareRequireAuthorization_ThatFallsOnTheOwnerOnlyDefault()
    {
        var route = Endpoint("/api/v1/training/routines", new HttpMethodMetadata(["GET"]), new Authorize());

        (await TrainingViolationsOfAsync(route)).Should().Contain(v => v.Contains("GET /api/v1/training/routines", StringComparison.Ordinal) && v.Contains("sem política nomeada", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TrainingScan_RejectsATrainingRouteWithoutAnyPolicy()
    {
        var route = Endpoint("/api/v1/training/routines", new HttpMethodMetadata(["GET"]));

        (await TrainingViolationsOfAsync(route)).Should().Contain(v => v.Contains("sem política nomeada", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TrainingScan_RejectsATrainingRouteOnTheOwnerOnlyPolicy_WhichWouldShutTheMembersOut()
    {
        var route = Endpoint("/api/v1/training/routines", new HttpMethodMetadata(["GET"]), new Authorize { Policy = UniOverAuth.OwnerPolicy });

        (await TrainingViolationsOfAsync(route)).Should().Contain(v =>
            v.StartsWith("GET /api/v1/training/routines:", StringComparison.Ordinal) && v.Contains("module:training", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TrainingScan_RejectsATrainingRouteThatDeclaresAnotherPermission()
    {
        var route = Endpoint(
            "/api/v1/training/routines", new HttpMethodMetadata(["GET"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TvControl) });

        (await TrainingViolationsOfAsync(route)).Should().Contain(v => v.Contains("declara [tv:control]", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TrainingScan_RejectsANewTrainingRouteThatIsNotInTheTable()
    {
        var route = Endpoint(
            "/api/v1/training/medidas", new HttpMethodMetadata(["PUT"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TrainingModule) });

        (await TrainingViolationsOfAsync(route)).Should().Contain(v => v.Contains("PUT /api/v1/training/medidas", StringComparison.Ordinal) && v.Contains("fora do mapa", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TrainingScan_RejectsTheCatalogImportOpenToTheMembers()
    {
        var route = Endpoint(
            "/api/v1/training/catalog/imports/wger", new HttpMethodMetadata(["POST"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TrainingModule) });

        var violations = await TrainingViolationsOfAsync(route);

        violations.Should().Contain(v => v.StartsWith("POST /api/v1/training/catalog/imports/wger:", StringComparison.Ordinal) && v.Contains("permissão [module:training]", StringComparison.Ordinal));
        violations.Should().Contain(v => v.StartsWith("POST /api/v1/training/catalog/imports/wger:", StringComparison.Ordinal) && v.Contains("exatamente administrador", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TrainingScan_RejectsTheCatalogImportWithoutTheNamedOwnerPolicy()
    {
        var route = Endpoint("/api/v1/training/catalog/imports/wger", new HttpMethodMetadata(["POST"]), new Authorize());

        (await TrainingViolationsOfAsync(route)).Should().Contain(v => v.Contains("sem política nomeada", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TrainingScan_RejectsTheTrainingPermissionOnARouteOutsideTheTraining()
    {
        var route = Endpoint(
            "/api/v1/tv/state", new HttpMethodMetadata(["GET"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TrainingModule) });

        (await TrainingViolationsOfAsync(route)).Should().Contain(v => v.Contains("rota fora do Treino com a permissão do Treino 'module:training'", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TrainingScan_AcceptsTheRoutesDeclaredAsTheTableSays()
    {
        var read = Endpoint(
            "/api/v1/training/routines", new HttpMethodMetadata(["GET"]), new Authorize { Policy = AccessPermissions.Policy(AccessPermissions.TrainingModule) });
        var import = Endpoint("/api/v1/training/catalog/imports/wger", new HttpMethodMetadata(["POST"]), new Authorize { Policy = UniOverAuth.OwnerPolicy });

        var violations = await TrainingViolationsOfAsync(read, import);

        // As demais linhas da tabela ficam sem rota (só há duas montadas), mas as rotas certas não geram violação própria.
        violations.Should().NotContain(v => v.StartsWith("GET /api/v1/training/routines:", StringComparison.Ordinal));
        violations.Should().NotContain(v => v.StartsWith("POST /api/v1/training/catalog/imports/wger:", StringComparison.Ordinal));
        violations.Should().OnlyContain(v => v.Contains("sem rota correspondente", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TrainingScan_FlagsEveryTableRowThatHasNoRoute()
    {
        var violations = await TrainingPermissionMap.ViolationsAsync([], PermissionPolicies());

        violations.Should().HaveCount(TrainingPermissionMap.Routes.Count + TrainingPermissionMap.AdminRoutes.Count);
    }

    [Fact]
    public void FillSample_ProducesRequestablePaths()
    {
        RouteInspector.FillSample("/api/v1/identity/passkeys/{id:guid}").Should().MatchRegex("^/api/v1/identity/passkeys/[0-9a-f-]{36}$");
        RouteInspector.FillSample("/api/v1/x/{name}/y/{n:int}").Should().Be("/api/v1/x/sample/y/1");
        RouteInspector.FillSample("/api/{**path}").Should().Be("/api/sample/path");
    }
}
