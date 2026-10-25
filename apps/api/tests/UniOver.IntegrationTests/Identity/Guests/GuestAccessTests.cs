using System.Net;
using AwesomeAssertions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using System.Security.Claims;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training;
using UniOver.IntegrationTests.Tv;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Tv;

namespace UniOver.IntegrationTests.Identity.Guests;

/// <summary>
/// O convidado alcança só a TV, o Treino e a própria sessão, e em cada módulo só o que as permissões dele cobrem. A
/// varredura vem das rotas do Host real (vale para módulo futuro sem editar o teste): por papel o convidado entra em toda
/// rota da TV e do Treino (menos a importação do catálogo, que é só do administrador), e é a permissão nomeada de cada
/// rota (tabelas em <see cref="TvPermissionMap"/> e <see cref="TrainingPermissionMap"/>) que decide; as chamadas HTTP
/// provam o 403 de fato e o que o convidado de hoje (a TV inteira, sem editar atalhos) consegue fazer.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class GuestAccessTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    /// <summary>
    /// As únicas rotas autenticadas (fora da TV e do Treino) que o convidado alcança: a própria sessão, inclusive as três
    /// do login por QR (o celular já conectado vê, confirma ou recusa o pedido do computador), que exigem sessão de conta ativa,
    /// e a confirmação da própria senha (o convidado a refaz antes de aprovar o próprio computador).
    /// </summary>
    private static readonly string[] GuestSessionRoutes =
    [
        "/api/v1/identity/me",
        "/api/v1/identity/auth/logout",
        "/api/v1/identity/auth/stream-ticket",
        "/api/v1/identity/auth/qr/info",
        "/api/v1/identity/auth/qr/approve",
        "/api/v1/identity/auth/qr/deny",
        "/api/v1/identity/step-up/password",
    ];

    /// <summary>Rotas que se autenticam por credencial própria (o agente do PC), não por papel de pessoa.</summary>
    private static readonly string[] RoleExempt =
    [
        "/api/v1/devices/agents/{agentId}/ws",
    ];

    /// <summary>
    /// Por papel o convidado entra em toda rota da TV (inclusive renomear e reordenar atalhos) e do Treino: o que o barra é
    /// a permissão da rota, que as tabelas de <see cref="TvPermissionMap"/> e <see cref="TrainingPermissionMap"/> conferem e
    /// as chamadas HTTP provam. As rotas de configuração da TV (<see cref="TvPermissionMap.AdminRoutes"/>) e a importação do
    /// catálogo do Treino (<see cref="TrainingPermissionMap.AdminRoutes"/>) são só do administrador, e o convidado nunca as
    /// alcança. A rota de administrador é identificada por método e caminho: <c>GET /tv/tvs</c> (listar as TVs de que o
    /// convidado é membro, com <c>module:tv</c>) divide o caminho com <c>POST /tv/tvs</c> (criar, só do administrador).
    /// </summary>
    private static bool IsGuestRoute(string method, string pattern) =>
        (pattern.StartsWith("/api/v1/tv/", StringComparison.Ordinal) && !TvPermissionMap.AdminRoutes.Any(r => IsRoute(r.Method, r.Pattern, method, pattern)))
        || (pattern.StartsWith("/api/v1/training/", StringComparison.Ordinal) && !TrainingPermissionMap.AdminRoutes.Any(r => IsRoute(r.Method, r.Pattern, method, pattern)))
        || GuestSessionRoutes.Contains(pattern)
        || pattern == TvPermissionMap.OwnPairingRoute;

    private static bool IsRoute(string ruleMethod, string rulePattern, string method, string pattern) =>
        rulePattern == pattern && string.Equals(ruleMethod, method, StringComparison.OrdinalIgnoreCase);

    private static IEnumerable<string> MethodsOf(RouteEndpoint endpoint) =>
        RouteInspector.Methods(endpoint) is { Count: > 0 } methods ? methods : [string.Empty];

    private static ClaimsPrincipal Principal(string? role)
    {
        var claims = new List<Claim> { new(UniOverAuth.SubjectClaim, Guid.NewGuid().ToString()) };
        if (role is not null)
        {
            claims.Add(new Claim(UniOverAuth.RoleClaim, role));
        }

        return new ClaimsPrincipal(new ClaimsIdentity(claims, "teste", UniOverAuth.SubjectClaim, UniOverAuth.RoleClaim));
    }

    private static async Task<HttpResponseMessage> OpenStreamAsync(HttpClient client, string path, string ticket)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Add("Cookie", $"uo_st={ticket}");
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, Ct);
    }

    private static async Task<string> TicketAsync(TvApp app, string bearer)
    {
        using var response = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: bearer);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return IdentityApp.Cookies(response).Single(c => c.Name == "uo_st").Value;
    }

    [Fact]
    public async Task EveryRouteOfTheHost_ObeysTheRolePolicy_GuestOnlyOnTheTvTheTrainingAndTheOwnSession()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var endpoints = app.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(e => RouteInspector.Classify(e) != RouteKind.Public)
            .ToList();
        var policies = app.Services.GetRequiredService<IAuthorizationPolicyProvider>();
        using var scope = app.Services.CreateScope();
        var authorization = scope.ServiceProvider.GetRequiredService<IAuthorizationService>();
        var inventory = TestContext.Current.TestOutputHelper;

        var failures = new List<string>();
        foreach (var endpoint in endpoints)
        {
            var pattern = RouteInspector.Pattern(endpoint);
            var label = RouteInspector.Describe(endpoint);
            var policy = (await AuthorizationPolicy.CombineAsync(policies, endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>()))!;
            var roleRequirements = policy.Requirements.OfType<AccountRoleRequirement>().ToList();

            if (roleRequirements.Count == 0)
            {
                if (!RoleExempt.Contains(pattern))
                {
                    failures.Add($"{label}: sem requisito de papel (rota nova precisa de política por papel)");
                }

                continue;
            }

            var owner = roleRequirements.All(r => r.Roles.Contains(AccountRoles.Owner));
            var unknown = roleRequirements.Any(r => r.Roles.Contains("admin") || r.Roles.Contains(string.Empty));
            inventory?.WriteLine($"  {label,-62} dono={owner}");

            // Checado de verdade pelo serviço de autorização, com principais de cada papel (e um papel inventado).
            var asOwner = (await authorization.AuthorizeAsync(Principal(AccountRoles.Owner), null, roleRequirements)).Succeeded;
            var asGuest = (await authorization.AuthorizeAsync(Principal(AccountRoles.Guest), null, roleRequirements)).Succeeded;
            var asLegacy = (await authorization.AuthorizeAsync(Principal(null), null, roleRequirements)).Succeeded;
            var asInvented = (await authorization.AuthorizeAsync(Principal("admin"), null, roleRequirements)).Succeeded;

            if (!asOwner)
            {
                failures.Add($"{label}: o dono não alcança");
            }

            if (asLegacy)
            {
                failures.Add($"{label}: token sem a claim de papel não vale como ninguém (nem como dono)");
            }

            if (asInvented || unknown)
            {
                failures.Add($"{label}: aceita um papel que não existe");
            }

            var guestExpected = MethodsOf(endpoint).All(method => IsGuestRoute(method, pattern));
            if (asGuest != guestExpected)
            {
                failures.Add($"{label}: convidado {(asGuest ? "alcança" : "não alcança")} e deveria {(guestExpected ? "alcançar" : "ser barrado")}");
            }

            // O convidado que entra por papel numa rota da TV só passa se a rota também exige uma permissão nomeada.
            if (asGuest && !GuestSessionRoutes.Contains(pattern) && !policy.Requirements.OfType<PermissionRequirement>().Any())
            {
                failures.Add($"{label}: o convidado alcança por papel sem exigir uma permissão nomeada");
            }

            // Toda rota que o convidado alcança (fora as da própria sessão) confere também que a conta não foi revogada.
            if (asGuest && !GuestSessionRoutes.Contains(pattern) && !policy.Requirements.OfType<ActiveAccountRequirement>().Any())
            {
                failures.Add($"{label}: o convidado alcança sem a conferência de conta ativa");
            }
        }

        endpoints.Count.Should().BeGreaterThan(20, "a varredura precisa ter visto as rotas dos quatro módulos");
        failures.Should().BeEmpty();
    }

    [Fact]
    public async Task GuestRoutesSeenByTheScan_AreExactlyTheTvTheTrainingAndTheOwnSession()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var policies = app.Services.GetRequiredService<IAuthorizationPolicyProvider>();
        using var scope = app.Services.CreateScope();
        var authorization = scope.ServiceProvider.GetRequiredService<IAuthorizationService>();

        var allowed = new List<string>();
        var allowedCalls = new List<string>();
        foreach (var endpoint in app.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(e => RouteInspector.Classify(e) != RouteKind.Public))
        {
            var policy = (await AuthorizationPolicy.CombineAsync(policies, endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>()))!;
            var roles = policy.Requirements.OfType<AccountRoleRequirement>().ToList();
            if (roles.Count > 0 && (await authorization.AuthorizeAsync(Principal(AccountRoles.Guest), null, roles)).Succeeded)
            {
                allowed.Add(RouteInspector.Pattern(endpoint));
                allowedCalls.Add(RouteInspector.Describe(endpoint));
            }
        }

        // Em Aparelhos o convidado alcança só a aprovação do próprio computador; nada do que é do administrador.
        allowed.Where(p => p.Contains("/devices/", StringComparison.Ordinal)).Distinct()
            .Should().BeEquivalentTo(["/api/v1/devices/pairing/approve-own"]);
        allowed.Where(p => !p.StartsWith("/api/v1/tv/", StringComparison.Ordinal) && !p.StartsWith("/api/v1/training/", StringComparison.Ordinal)
                && !p.Contains("/devices/", StringComparison.Ordinal))
            .Distinct().Should().BeEquivalentTo(GuestSessionRoutes);
        allowed.Count(p => p.StartsWith("/api/v1/tv/", StringComparison.Ordinal)).Should().BeGreaterThanOrEqualTo(10);

        // No Treino o convidado entra por papel em todas as rotas de dado da conta e em nenhuma de dado global: a importação
        // do catálogo do wger (e qualquer rota fora da tabela) não está entre as que ele alcança.
        allowed.Where(p => p.StartsWith("/api/v1/training/", StringComparison.Ordinal)).Distinct()
            .Should().BeEquivalentTo(TrainingPermissionMap.Routes.Select(r => r.Pattern).Distinct());
        allowedCalls.Should().NotContain(TrainingPermissionMap.AdminRoutes.Select(r => $"{r.Method} {r.Pattern}"));

        // Na TV o convidado nunca alcança a configuração nem a gestão das TVs (criar, renomear, apagar, filiar), mas lista as
        // TVs de que é membro: o mesmo caminho /tv/tvs é dele para ler e só do administrador para escrever.
        allowedCalls.Should().NotContain(TvPermissionMap.AdminRoutes.Select(r => $"{r.Method} {r.Pattern}"));
        allowedCalls.Should().Contain("GET /api/v1/tv/tvs");

        // Renomear e reordenar atalhos entram por papel como o resto da TV: a barreira é a permissão tv:edit-shortcuts, e a
        // tabela abaixo prova que cada rota da TV (e só a TV) exige exatamente a permissão da sua linha.
        allowed.Should().Contain(["/api/v1/tv/shortcuts/{id:guid}", "/api/v1/tv/shortcuts/order"]);
        var routes = app.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>().ToList();
        (await TvPermissionMap.ViolationsAsync(routes, policies)).Should().BeEmpty();
        (await TrainingPermissionMap.ViolationsAsync(routes, policies)).Should().BeEmpty();
    }

    [Fact]
    public async Task Guest_GetsA403OnDevicesTrainingAndOwnerOnlyAccountRoutes_And200OnTheTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var token = guest.Login.AccessToken;

        var forbidden = new (HttpMethod Method, string Url, object? Body)[]
        {
            // O convidado de hoje não tem tv:edit-shortcuts: renomear, ocultar e reordenar atalhos seguem recusados.
            (HttpMethod.Patch, $"/api/v1/tv/shortcuts/{Guid.NewGuid()}", new { customLabel = "Meu app" }),
            (HttpMethod.Put, "/api/v1/tv/shortcuts/order", new { ids = new[] { Guid.NewGuid() } }),
            (HttpMethod.Get, "/api/v1/devices/agents", null),
            (HttpMethod.Get, "/api/v1/tv/config", null),
            (HttpMethod.Put, "/api/v1/tv/config/agent", new { agentSlug = "pc-casa" }),
            (HttpMethod.Post, $"/api/v1/devices/agents/{Guid.NewGuid()}/revoke", null),
            (HttpMethod.Post, $"/api/v1/devices/agents/{Guid.NewGuid()}/logs", new { lines = 10 }),
            (HttpMethod.Post, $"/api/v1/devices/agents/{Guid.NewGuid()}/maintenance", new { action = "restart" }),
            (HttpMethod.Post, "/api/v1/devices/pairing/approve", new { userCode = "ABCD-EFGH" }),
            (HttpMethod.Post, "/api/v1/devices/pairing/deny", new { userCode = "ABCD-EFGH" }),
            (HttpMethod.Get, "/api/v1/training/exercises", null),
            (HttpMethod.Get, "/api/v1/training/routines", null),
            (HttpMethod.Get, "/api/v1/training/sessions", null),
            (HttpMethod.Get, "/api/v1/training/goals", null),
            (HttpMethod.Get, "/api/v1/training/catalog/credits", null),
            (HttpMethod.Post, "/api/v1/training/catalog/imports/wger", null),
            (HttpMethod.Get, "/api/v1/identity/passkeys", null),
            (HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { password = guest.Password }),
            (HttpMethod.Post, "/api/v1/identity/step-up/options", new { action = "identity.guest-invite" }),
            (HttpMethod.Post, "/api/v1/identity/guest-invites", new { displayName = "Outro" }),
            (HttpMethod.Get, "/api/v1/identity/guest-invites", null),
            (HttpMethod.Get, "/api/v1/identity/guests", null),
            (HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke", null),
            (HttpMethod.Post, $"/api/v1/identity/guest-invites/{Guid.NewGuid()}/revoke", null),
            (HttpMethod.Put, $"/api/v1/identity/guests/{guest.UserId}/permissions", new { permissions = new[] { "module:tv", "module:training" } }),
        };
        foreach (var (method, url, body) in forbidden)
        {
            using var response = await app.SendAsync(method, url, body, bearer: token);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"{method} {url}");
        }

        // E o Treino inteiro (as rotas de dado e a importação do catálogo): o convidado de hoje só tem a TV.
        foreach (var (method, pattern, url, body) in TrainingPermissionMap.AllCalls())
        {
            using var response = await app.SendAsync(new HttpMethod(method), url, body, bearer: token);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"{method} {pattern} para quem só tem a TV");
        }

        // E o convidado não se revogou nem se promoveu por tentativa.
        await using var db = app.Identity();
        (await db.Users.SingleAsync(u => u.Id == guest.UserId, Ct)).DisabledAt.Should().BeNull();
        (await db.UserGrants.Where(g => g.UserId == guest.UserId).Select(g => g.Permission).ToListAsync(Ct))
            .Should().BeEquivalentTo(PermissionRules.TvControlOnly, "o convidado não ampliou as próprias permissões");

        foreach (var url in new[] { "/api/v1/tv/state", "/api/v1/tv/shortcuts", "/api/v1/tv/commands/recent", "/api/v1/identity/me" })
        {
            using var response = await app.GetAsync(url, bearer: token);
            response.StatusCode.Should().Be(HttpStatusCode.OK, url);
        }
    }

    [Fact]
    public async Task Guest_WithAForgedRole_IsRefusedEverywhere_EvenOnTheTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var key = app.SigningKey;
        var now = app.Time.GetUtcNow();
        string Token(string role) => IdentityApp.CraftToken(key, now.AddMinutes(-1), now.AddHours(1), role: role);

        foreach (var role in new[] { "admin", "Owner", "GUEST", string.Empty })
        {
            using var tv = await app.GetAsync("/api/v1/tv/state", bearer: Token(role));
            using var devices = await app.GetAsync("/api/v1/devices/agents", bearer: Token(role));
            tv.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"papel '{role}' na TV");
            devices.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"papel '{role}' em Aparelhos");
        }
    }

    [Fact]
    public async Task TokenWithoutTheRoleClaim_IsDeniedEverywhere_ItIsNoLongerTheOwner()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        var roleless = IdentityApp.CraftToken(app.SigningKey, now.AddMinutes(-1), now.AddHours(1), role: null);

        // O token está assinado e dentro da validade: a autenticação passa, mas nenhuma política aceita quem não tem papel.
        foreach (var (method, url) in new[]
        {
            (HttpMethod.Get, "/api/v1/devices/agents"),
            (HttpMethod.Get, "/api/v1/tv/state"),
            (HttpMethod.Get, "/api/v1/identity/me"),
            (HttpMethod.Patch, "/api/v1/identity/me"),
            (HttpMethod.Get, "/api/v1/identity/guests"),
            (HttpMethod.Get, "/api/v1/training/exercises"),
            (HttpMethod.Post, "/api/v1/identity/auth/stream-ticket"),
        })
        {
            using var response = await app.SendAsync(method, url, method == HttpMethod.Patch ? new { displayName = "Nome" } : null, bearer: roleless);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"{method} {url} com token sem papel");
        }
    }

    [Fact]
    public async Task TokenWithAnOwnerRole_FromAnotherAccount_StillReachesTheOwnerRoutes()
    {
        // O papel explícito de dono (o que o servidor sempre emite) continua valendo: só o "sem papel" deixou de valer.
        await using var app = await TvApp.StartAsync(postgres);

        using var devices = await app.GetAsync("/api/v1/devices/agents", bearer: app.OtherUserToken());
        using var tv = await app.GetAsync("/api/v1/tv/state", bearer: app.OtherUserToken());

        devices.StatusCode.Should().Be(HttpStatusCode.OK);
        tv.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Owner_StillReachesEverythingTheGuestCannot()
    {
        await using var app = await TvApp.StartAsync(postgres);

        foreach (var url in new[]
        {
            "/api/v1/devices/agents", "/api/v1/identity/passkeys", "/api/v1/identity/guests", "/api/v1/identity/guest-invites",
            "/api/v1/tv/state", "/api/v1/tv/config", "/api/v1/identity/me",
        })
        {
            using var response = await app.GetAsync(url);
            response.StatusCode.Should().Be(HttpStatusCode.OK, url);
        }
    }

    [Fact]
    public async Task Guest_UsesTheWholeTv_PowerOffIncluded_WithoutAnyPasskey()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var token = guest.Login.AccessToken;

        var key = app.SendAsync(HttpMethod.Post, "/api/v1/tv/keys", new { key = "VOLUME_UP" }, bearer: token);
        var keyCommand = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, keyCommand);
        using var keyResponse = await Within(key);

        var text = app.SendAsync(HttpMethod.Post, "/api/v1/tv/text", new { text = "filme" }, bearer: token);
        var textCommand = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, textCommand);
        using var textResponse = await Within(text);

        var off = app.SendAsync(HttpMethod.Post, "/api/v1/tv/power/off", bearer: token);
        var offCommand = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, offCommand);
        using var offResponse = await Within(off);

        keyResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        textResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        offResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        keyCommand.GetProperty("type").GetString().Should().Be("tv.key.v2");
        offCommand.GetProperty("type").GetString().Should().Be("tv.key.v2");

        // Cada comando grava QUEM mandou: o id do convidado, nunca o do dono.
        await using var db = app.Db();
        var rows = await db.CommandAudit.ToListAsync(Ct);
        rows.Should().HaveCount(3).And.OnlyContain(r => r.UserId == guest.UserId);
    }

    [Fact]
    public async Task RecentCommands_TheGuestSeesOnlyHisOwn_TheOwnerSeesAllAndWhichAreHis()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        async Task SendAsOwnerOrGuestAsync(string? bearer, string key)
        {
            var request = app.SendAsync(HttpMethod.Post, "/api/v1/tv/keys", new { key }, bearer: bearer);
            var command = await TvApp.NextCommandAsync(agent);
            await TvApp.ReplyAsync(agent, command);
            (await Within(request)).Dispose();
        }

        await SendAsOwnerOrGuestAsync(string.Empty, "HOME");
        await SendAsOwnerOrGuestAsync(guest.Login.AccessToken, "VOLUME_UP");
        await SendAsOwnerOrGuestAsync(string.Empty, "BACK");
        await SendAsOwnerOrGuestAsync(guest.Login.AccessToken, "MUTE");

        using var asGuest = await app.GetAsync("/api/v1/tv/commands/recent", bearer: guest.Login.AccessToken);
        using var asOwner = await app.GetAsync("/api/v1/tv/commands/recent");

        var guestRows = (await TvApp.JsonAsync(asGuest)).EnumerateArray().ToList();
        guestRows.Select(r => r.GetProperty("detail").GetString()).Should().Equal("MUTE", "VOLUME_UP");
        guestRows.Should().OnlyContain(r => r.GetProperty("byMe").GetBoolean());
        (await asGuest.Content.ReadAsStringAsync(Ct)).Should().NotContain(guest.UserId.ToString(), "o histórico não expõe ids");

        var ownerRows = (await TvApp.JsonAsync(asOwner)).EnumerateArray().ToList();
        ownerRows.Select(r => r.GetProperty("detail").GetString()).Should().Equal("MUTE", "BACK", "VOLUME_UP", "HOME");
        ownerRows.Select(r => r.GetProperty("byMe").GetBoolean()).Should().Equal(false, true, false, true);
    }

    [Fact]
    public async Task Stream_TheGuestTicketOpensTheTvFlow_ButNeverTheDevicesFlow()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var guestTicket = await TicketAsync(app, guest.Login.AccessToken);
        var ownerTicket = await TicketAsync(app, app.Login.AccessToken);

        using var guestTv = await OpenStreamAsync(app.Client, "/api/v1/tv/events", guestTicket);
        using var guestDevices = await OpenStreamAsync(app.Client, "/api/v1/devices/events", guestTicket);
        using var ownerTv = await OpenStreamAsync(app.Client, "/api/v1/tv/events", ownerTicket);
        using var ownerDevices = await OpenStreamAsync(app.Client, "/api/v1/devices/events", ownerTicket);

        guestTv.StatusCode.Should().Be(HttpStatusCode.OK);
        guestTv.Content.Headers.ContentType!.MediaType.Should().Be("text/event-stream");
        guestDevices.StatusCode.Should().Be(HttpStatusCode.Forbidden, "o bilhete de convidado não abre o fluxo de Aparelhos");
        ownerTv.StatusCode.Should().Be(HttpStatusCode.OK);
        ownerDevices.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Stream_TheTicketCarriesTheRole()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        var ticket = await TicketAsync(app, guest.Login.AccessToken);

        new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().ReadJsonWebToken(ticket)
            .GetClaim("role").Value.Should().Be("guest");
    }

    [Fact]
    public async Task RevokedGuest_LosesTheTv_WithinTheShortJwtLifetime()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke");
        using var ticket = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: guest.Login.AccessToken);
        app.Time.Advance(TimeSpan.FromMinutes(11));
        using var key = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/keys", new { key = "HOME" }, bearer: guest.Login.AccessToken);

        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        ticket.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        key.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0, "nada chegou à TV depois do prazo");
    }

    [Fact]
    public async Task OwnerSessionsAreNotAffectedByRevokingAGuest()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke");
        using var ownerTicket = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket");

        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        ownerTicket.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GuestLogout_RevokesOnlyTheirSession()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var logout = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: guest.Login.AccessToken);
        using var ticket = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: guest.Login.AccessToken);
        using var ownerTicket = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket");

        logout.StatusCode.Should().Be(HttpStatusCode.NoContent);
        ticket.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        ownerTicket.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
