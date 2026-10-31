using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// A permissão do UniOver na TV Samsung: o agente avisa que a TV deixou de reconhecê-lo, a API guarda o estado por TV e
/// só quem usa aquela TV o vê, e o aviso na tela da TV só é pedido por um pedido explícito. Também a procura de TVs na
/// rede do computador, que o administrador usa ao adicionar uma TV.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class SamsungPermissionTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    private static JsonObject PermissionBody(string state) => new() { ["state"] = state, ["at"] = "2026-10-31T12:00:00Z" };

    private static async Task<VirtualAuthenticator> ConfirmedOwnerAsync(TvApp app)
    {
        var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, "tv.bind-agent");
        return authenticator;
    }

    private static async Task BindDefaultAsync(TvApp app)
    {
        using var response = await app.SendAsync(HttpMethod.Put, "/api/v1/tv/config/agent", new { agentSlug = app.Agent.Slug });
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private static async Task<Guid> CreateTvAsync(TvApp app, string agentSlug, string name)
    {
        using var response = await app.PostAsync("/api/v1/tv/tvs", new { agentSlug, name });
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await TvApp.JsonAsync(response)).GetProperty("id").GetGuid();
    }

    private static async Task SetMembersAsync(TvApp app, Guid tvId, params Guid[] userIds)
    {
        using var response = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/tvs/{tvId}/members", new { userIds });
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private static async Task<List<Guid>> PendingAsync(TvApp app, string? bearer = "")
    {
        using var response = await app.GetAsync("/api/v1/tv/permission", bearer);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return [.. (await TvApp.JsonAsync(response)).GetProperty("items").EnumerateArray().Select(item => item.GetProperty("tvId").GetGuid())];
    }

    /// <summary>A TV do Raphael (Samsung, em outra casa) com o computador dele conectado e dizendo que sabe pedir a permissão.</summary>
    private sealed record Scenario(TvApp App, Guid RaphaelTv, PairedAgent RaphaelAgent, FakeAgent Agent, GuestSession Raphael, GuestSession Other, Guid OtherTv);

    private async Task<Scenario> StartScenarioAsync(bool agentKnowsPermission = true)
    {
        var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var raphaelAgent = await app.PairAsync("PC Raphael");
        var raphaelTv = await CreateTvAsync(app, raphaelAgent.Slug, "TV Raphael");
        var otherAgent = await app.PairAsync("PC Outro");
        var otherTv = await CreateTvAsync(app, otherAgent.Slug, "TV Outro");
        var raphael = await app.NewGuestAsync("Raphael", ["module:tv", "tv:control"], 91);
        var other = await app.NewGuestAsync("Outro", ["module:tv", "tv:control"], 92);
        await SetMembersAsync(app, raphaelTv, raphael.UserId);
        await SetMembersAsync(app, otherTv, other.UserId);

        var agent = await app.ConnectAsync(raphaelAgent);
        if (agentKnowsPermission)
        {
            await agent.SendHelloAsync("2.0.0", "tv.remote", "tv.kind.samsung", "tv.permission.v1", "tv.discovery.v1");
        }
        else
        {
            await agent.SendHelloAsync("2.0.0", "tv.remote", "tv.kind.samsung");
        }

        await TvApp.WaitUntilAsync(
            () => app.Presence.Get(raphaelAgent.Slug)?.Capabilities.Contains("tv.kind.samsung", StringComparer.Ordinal) == true,
            "capacidades do agente do Raphael");
        return new Scenario(app, raphaelTv, raphaelAgent, agent, raphael, other, otherTv);
    }

    private static async Task SayAsync(Scenario scenario, string state)
    {
        await scenario.Agent.SendTextAsync(scenario.Agent.Envelope("tv.permission.v1", PermissionBody(state)));
        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = scenario.App.Db();
            var tv = await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == scenario.RaphaelTv, Ct);
            return tv.PermissionNeeded == (state == "needed");
        }, $"estado da permissão {state}");
    }

    [Fact]
    public async Task Needed_IsStoredPerTv_AndOnlyTheMembersOfThatTvSeeIt()
    {
        var s = await StartScenarioAsync();
        await using var app = s.App;
        await using var agent = s.Agent;

        await SayAsync(s, "needed");

        (await PendingAsync(app, s.Raphael.Login.AccessToken)).Should().Equal(s.RaphaelTv);
        // Quem usa outra TV não vê o aviso desta, nem o estado dela na lista.
        (await PendingAsync(app, s.Other.Login.AccessToken)).Should().BeEmpty();
        using (var otherList = await app.GetAsync("/api/v1/tv/tvs", s.Other.Login.AccessToken))
        {
            var items = (await TvApp.JsonAsync(otherList)).GetProperty("items").EnumerateArray().ToList();
            items.Should().ContainSingle().Which.GetProperty("permissionNeeded").GetBoolean().Should().BeFalse();
        }

        // O administrador vê todas as TVs na lista, mas o aviso é de quem as usa: não é membro dela, nem é a padrão.
        (await PendingAsync(app)).Should().BeEmpty();
        using (var ownerList = await app.GetAsync("/api/v1/tv/tvs"))
        {
            var raphaelItem = (await TvApp.JsonAsync(ownerList)).GetProperty("items").EnumerateArray()
                .Single(item => item.GetProperty("id").GetGuid() == s.RaphaelTv);
            raphaelItem.GetProperty("permissionNeeded").GetBoolean().Should().BeTrue();
        }

        using (var raphaelList = await app.GetAsync("/api/v1/tv/tvs", s.Raphael.Login.AccessToken))
        {
            (await TvApp.JsonAsync(raphaelList)).GetProperty("items").EnumerateArray().Should().ContainSingle()
                .Which.GetProperty("permissionNeeded").GetBoolean().Should().BeTrue();
        }
    }

    [Fact]
    public async Task Granted_ClearsTheState_AndRepeatedWarningsDoNotRewriteTheRow()
    {
        var s = await StartScenarioAsync();
        await using var app = s.App;
        await using var agent = s.Agent;

        await SayAsync(s, "needed");
        DateTimeOffset? first;
        await using (var db = app.Db())
        {
            first = (await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == s.RaphaelTv, Ct)).PermissionChangedAt;
        }

        // O agente repete o aviso a cada conexão: nada novo para gravar.
        await s.Agent.SendTextAsync(s.Agent.Envelope("tv.permission.v1", new JsonObject { ["state"] = "needed", ["at"] = "2026-10-31T13:00:00Z" }));
        await app.SettleAsync();
        await using (var db = app.Db())
        {
            (await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == s.RaphaelTv, Ct)).PermissionChangedAt.Should().Be(first);
        }

        await SayAsync(s, "granted");
        (await PendingAsync(app, s.Raphael.Login.AccessToken)).Should().BeEmpty();
    }

    [Fact]
    public async Task Request_ReachesTheAgentOnce_WithoutAnyHostOrAddress()
    {
        var s = await StartScenarioAsync();
        await using var app = s.App;
        await using var agent = s.Agent;
        await SayAsync(s, "needed");

        var request = app.PostAsync($"/api/v1/tv/permission/request?tvId={s.RaphaelTv}", bearer: s.Raphael.Login.AccessToken);
        var command = await TvApp.NextCommandAsync(agent);

        command.GetProperty("type").GetString().Should().Be("tv.permission.request.v1");
        command.GetProperty("target").GetString().Should().Be($"agent:{s.RaphaelAgent.Slug}");
        command.GetProperty("body").GetRawText().Should().Be("{}");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("ok").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Request_ForAnotherPersonsTv_IsNotFound_AndNothingReachesAnyAgent()
    {
        var s = await StartScenarioAsync();
        await using var app = s.App;
        await using var agent = s.Agent;

        // O outro usuário não vê a TV do Raphael: nem sabe que ela existe.
        using var response = await Within(app.PostAsync($"/api/v1/tv/permission/request?tvId={s.RaphaelTv}", bearer: s.Other.Login.AccessToken));
        response.StatusCode.Should().Be(HttpStatusCode.NotFound);

        // E o agente do Raphael não recebeu nada: o próximo comando é o da sondagem seguinte.
        var probe = app.PostAsync("/api/v1/tv/wake", bearer: s.Raphael.Login.AccessToken);
        var next = await TvApp.NextCommandAsync(agent);
        next.GetProperty("type").GetString().Should().Be("tv.wake.v1");
        await TvApp.ReplyAsync(agent, next);
        (await Within(probe)).Dispose();
    }

    [Fact]
    public async Task Request_ToAnAgentWithoutTheCapability_IsRefusedWithAClearProblem_AndSendsNothing()
    {
        var s = await StartScenarioAsync(agentKnowsPermission: false);
        await using var app = s.App;
        await using var agent = s.Agent;

        using var response = await Within(app.PostAsync($"/api/v1/tv/permission/request?tvId={s.RaphaelTv}", bearer: s.Raphael.Login.AccessToken));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("permission-unsupported");
        var probe = app.PostAsync("/api/v1/tv/wake", bearer: s.Raphael.Login.AccessToken);
        var next = await TvApp.NextCommandAsync(agent);
        next.GetProperty("type").GetString().Should().Be("tv.wake.v1", "o pedido recusado não chegou ao agente");
        await TvApp.ReplyAsync(agent, next);
        (await Within(probe)).Dispose();
    }

    [Fact]
    public async Task Request_WhenTheTvDoesNotAnswer_ReportsTheAgentCode()
    {
        var s = await StartScenarioAsync();
        await using var app = s.App;
        await using var agent = s.Agent;

        var request = app.PostAsync($"/api/v1/tv/permission/request?tvId={s.RaphaelTv}", bearer: s.Raphael.Login.AccessToken);
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed("tv_unreachable"));

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await TvApp.JsonAsync(response)).GetProperty("agentError").GetString().Should().Be("tv_unreachable");
    }

    [Fact]
    public async Task Request_NeedsTheControlPermission_AndASession()
    {
        var s = await StartScenarioAsync();
        await using var app = s.App;
        await using var agent = s.Agent;
        // Sem filiação a conta usa a TV padrão; só o módulo, sem controle, não pede nada à TV.
        var viewer = await app.NewGuestAsync("So Olha", ["module:tv"], 93);

        using var anonymous = await app.PostAsync("/api/v1/tv/permission/request", bearer: null);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        using var forbidden = await app.PostAsync("/api/v1/tv/permission/request", bearer: viewer.Login.AccessToken);
        forbidden.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        using var listAnonymous = await app.GetAsync("/api/v1/tv/permission", bearer: null);
        listAnonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        // O módulo sem nenhuma permissão da TV também não lê a lista.
        var outsider = await app.NewGuestAsync("Sem TV", ["module:training"], 94);
        using var noModule = await app.GetAsync("/api/v1/tv/permission", bearer: outsider.Login.AccessToken);
        noModule.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Nearby_ListsWhatTheComputerFound_WithoutAddresses_AndOnlyForTheAdministrator()
    {
        var s = await StartScenarioAsync();
        await using var app = s.App;
        await using var agent = s.Agent;

        var request = app.GetAsync($"/api/v1/tv/tvs/nearby?agent={s.RaphaelAgent.Slug}");
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.discover.v1");
        var requestId = command.GetProperty("body").GetProperty("requestId").GetGuid();
        await agent.SendTextAsync(agent.Envelope(
            "tv.discovery.v1",
            new JsonObject
            {
                ["requestId"] = requestId,
                ["tvs"] = new JsonArray(
                    new JsonObject { ["id"] = "a1b2c3d4e5f60718", ["kind"] = "samsung", ["name"] = "Samsung Sala", ["controlled"] = true },
                    new JsonObject { ["id"] = "f0e1d2c3b4a59687", ["kind"] = "android", ["name"] = null, ["controlled"] = false }),
                ["at"] = "2026-10-31T12:00:00Z",
            },
            command.GetProperty("id").GetGuid()));
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await TvApp.JsonAsync(response);
        body.GetProperty("status").GetString().Should().Be("ok");
        var items = body.GetProperty("items").EnumerateArray().ToList();
        items.Select(item => item.GetProperty("id").GetString()).Should().Equal("a1b2c3d4e5f60718", "f0e1d2c3b4a59687");
        items[0].GetProperty("controlled").GetBoolean().Should().BeTrue();
        items.SelectMany(item => item.EnumerateObject().Select(p => p.Name)).Distinct()
            .Should().BeEquivalentTo(["id", "kind", "name", "controlled"], "nada de endereço IP nem de MAC chega à tela");

        // Quem não é administrador não procura TVs na rede de ninguém.
        using var guest = await app.GetAsync($"/api/v1/tv/tvs/nearby?agent={s.RaphaelAgent.Slug}", s.Raphael.Login.AccessToken);
        guest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        using var anonymous = await app.GetAsync($"/api/v1/tv/tvs/nearby?agent={s.RaphaelAgent.Slug}", bearer: null);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Nearby_ForAComputerThatIsNotAnyTvYet_StillGetsItsList()
    {
        // Ao adicionar uma TV, o computador escolhido ainda não controla nenhuma.
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var fresh = await app.PairAsync("PC Novo");
        await using var agent = await app.ConnectAsync(fresh);
        await agent.SendHelloAsync("2.0.0", "tv.remote", "tv.discovery.v1");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(fresh.Slug)?.Capabilities.Contains("tv.discovery.v1", StringComparer.Ordinal) == true, "hello");

        var request = app.GetAsync($"/api/v1/tv/tvs/nearby?agent={fresh.Slug}");
        var command = await TvApp.NextCommandAsync(agent);
        await agent.SendTextAsync(agent.Envelope(
            "tv.discovery.v1",
            new JsonObject
            {
                ["requestId"] = command.GetProperty("body").GetProperty("requestId").GetGuid(),
                ["tvs"] = new JsonArray(new JsonObject { ["id"] = "a1b2c3d4e5f60718", ["kind"] = "samsung", ["name"] = "Sala", ["controlled"] = false }),
                ["at"] = "2026-10-31T12:00:00Z",
            },
            command.GetProperty("id").GetGuid()));
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        (await TvApp.JsonAsync(response)).GetProperty("items").EnumerateArray().Should().ContainSingle();
    }

    [Fact]
    public async Task Nearby_IgnoresAListFromAnotherComputer()
    {
        var s = await StartScenarioAsync();
        await using var app = s.App;
        await using var agent = s.Agent;
        var intruderAgent = await app.PairAsync("PC Intruso");
        await using var intruder = await app.ConnectAsync(intruderAgent);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(intruderAgent.Slug)?.Connected == true, "intruso conectado");

        var request = app.GetAsync($"/api/v1/tv/tvs/nearby?agent={s.RaphaelAgent.Slug}");
        var command = await TvApp.NextCommandAsync(agent);
        await intruder.SendTextAsync(intruder.Envelope(
            "tv.discovery.v1",
            new JsonObject
            {
                ["requestId"] = command.GetProperty("body").GetProperty("requestId").GetGuid(),
                ["tvs"] = new JsonArray(new JsonObject { ["id"] = "00000000aaaaaaaa", ["kind"] = "samsung", ["name"] = "Falsa", ["controlled"] = false }),
                ["at"] = "2026-10-31T12:00:00Z",
            },
            command.GetProperty("id").GetGuid()));
        await TvApp.WaitUntilAsync(() => app.Presence.Get(intruderAgent.Slug)?.LastMessageAt is not null, "mensagem do intruso lida");
        await TvApp.ReplyAsync(agent, command);

        using var response = await app.AdvanceWhilePendingAsync(request);
        (await TvApp.JsonAsync(response)).GetProperty("status").GetString().Should().Be("failed", "a lista de outro computador não vale");
    }

    [Fact]
    public async Task Nearby_ReportsOfflineAndUnsupportedComputersWithoutSendingAnything()
    {
        var s = await StartScenarioAsync(agentKnowsPermission: false);
        await using var app = s.App;
        await using var agent = s.Agent;
        var asleep = await app.PairAsync("PC Dormindo");

        using (var unsupported = await app.GetAsync($"/api/v1/tv/tvs/nearby?agent={s.RaphaelAgent.Slug}"))
        {
            (await TvApp.JsonAsync(unsupported)).GetProperty("status").GetString().Should().Be("unsupported");
        }

        using (var offline = await app.GetAsync($"/api/v1/tv/tvs/nearby?agent={asleep.Slug}"))
        {
            (await TvApp.JsonAsync(offline)).GetProperty("status").GetString().Should().Be("offline");
        }

        using var invalid = await app.GetAsync("/api/v1/tv/tvs/nearby");
        invalid.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task TheMigrationOnlyAddsColumns_ExistingTvsKeepTheirDataAndStartWithoutPendingPermission()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using var db = TvApp.CreateContext(database.OwnerConnection);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync("20261030224800_AddFocusClosesBackground", Ct);
        var tvId = Guid.NewGuid();
        await db.Database.ExecuteSqlRawAsync(
            "INSERT INTO tv.tvs (id, name, agent_slug, is_default, created_at, updated_at, updated_by) " +
            "VALUES ({0}, 'TV Antiga', 'pc-antigo', false, now(), now(), {1})",
            [tvId, Guid.NewGuid()],
            Ct);

        await db.Database.MigrateAsync(Ct);

        var tv = await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == tvId, Ct);
        tv.Name.Should().Be("TV Antiga");
        tv.AgentSlug.Should().Be("pc-antigo");
        tv.PermissionNeeded.Should().BeFalse();
        tv.PermissionChangedAt.Should().BeNull();
    }

    [Fact]
    public async Task Hello_WithTheNewCapabilities_IsAccepted()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendHelloAsync("2.0.0", "tv.remote", "tv.permission.v1", "tv.discovery.v1");
        await TvApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.permission.v1", StringComparer.Ordinal) == true,
            "capacidades novas");
        app.Presence.Get(app.Agent.Slug)!.Capabilities.Should().Contain(["tv.permission.v1", "tv.discovery.v1"]);
    }
}
