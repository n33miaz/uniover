using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class ShortcutOrderTests(PostgresFixture postgres)
{
    private const string OrderUrl = "/api/v1/tv/shortcuts/order";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<List<JsonElement>> ListAsync(TvApp app)
    {
        using var response = await app.GetAsync("/api/v1/tv/shortcuts");
        return (await TvApp.JsonAsync(response)).EnumerateArray().Select(e => e.Clone()).ToList();
    }

    /// <summary>O agente manda a lista de apps (<c>tv.apps.v1</c>) e o teste espera os atalhos aparecerem.</summary>
    private static async Task<List<JsonElement>> SendAppsAsync(TvApp app, FakeAgent agent, int expectedCount, params (string Package, string? Label)[] apps)
    {
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(apps)));
        List<JsonElement> list = [];
        await TvApp.WaitUntilAsync(async () =>
        {
            list = await ListAsync(app);
            return list.Count == expectedCount;
        }, $"{expectedCount} atalhos");
        return list;
    }

    private static Guid[] IdsOf(List<JsonElement> list, params string[] packagesInOrder) =>
        [.. packagesInOrder.Select(p => list.Single(s => s.GetProperty("package").GetString() == p).GetProperty("id").GetGuid())];

    private static string[] Packages(List<JsonElement> list) => [.. list.Select(s => s.GetProperty("package").GetString()!)];

    private static Task<HttpResponseMessage> PutOrderAsync(TvApp app, IEnumerable<Guid> ids, string? bearer = "") =>
        app.SendAsync(HttpMethod.Put, OrderUrl, new { ids }, bearer);

    [Fact]
    public async Task Reorder_SavesTheOrder_AndTheListingReturnsItWithPositionsFromOneToN()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 4, ("com.a.um", "Um"), ("com.b.dois", "Dois"), ("com.c.tres", "Três"), ("com.d.quatro", "Quatro"));

        app.Time.Advance(TimeSpan.FromMinutes(3));
        using var response = await PutOrderAsync(app, IdsOf(list, "com.c.tres", "com.a.um", "com.d.quatro", "com.b.dois"));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var returned = (await TvApp.JsonAsync(response)).EnumerateArray().Select(e => e.Clone()).ToList();
        Packages(returned).Should().Equal("com.c.tres", "com.a.um", "com.d.quatro", "com.b.dois");
        returned.Select(s => s.GetProperty("position").GetInt32()).Should().Equal(1, 2, 3, 4);

        // A listagem (e uma tela que recarrega) vê a mesma ordem, e o rótulo da TV segue com cada app.
        var again = await ListAsync(app);
        Packages(again).Should().Equal("com.c.tres", "com.a.um", "com.d.quatro", "com.b.dois");
        again.Select(s => s.GetProperty("tvLabel").GetString()).Should().Equal("Três", "Um", "Quatro", "Dois");

        await using var db = app.Db();
        var rows = await db.Shortcuts.AsNoTracking().OrderBy(s => s.Position).ToListAsync(Ct);
        rows.Select(s => s.Package).Should().Equal("com.c.tres", "com.a.um", "com.d.quatro", "com.b.dois");
        rows.Single(s => s.Package == "com.c.tres").UpdatedAt.Should().Be(app.Time.GetUtcNow(), "quem mudou de lugar tem a hora da mudança");
    }

    [Fact]
    public async Task Reorder_AlsoPlacesTheAppsOutOfTheControlAndTheOnesThatLeftTheTv_WithoutChangingWhoIsInTheControl()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 3, ("com.a.um", "Um"), ("com.b.dois", "Dois"), ("com.c.tres", "Três"));
        var hidden = IdsOf(list, "com.b.dois").Single();
        (await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{hidden}", new { enabled = false })).Dispose();

        // "com.c.tres" sai da TV: continua guardado, e continua na ordem.
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.a.um", "Um"), ("com.b.dois", "Dois"))));
        await TvApp.WaitUntilAsync(async () =>
            (await ListAsync(app)).Single(s => s.GetProperty("package").GetString() == "com.c.tres").GetProperty("installed").GetBoolean() == false,
            "terceiro app fora da TV");

        using var response = await PutOrderAsync(app, IdsOf(list, "com.c.tres", "com.b.dois", "com.a.um"));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var after = await ListAsync(app);
        Packages(after).Should().Equal("com.c.tres", "com.b.dois", "com.a.um");
        after.Select(s => s.GetProperty("enabled").GetBoolean()).Should().Equal(false, false, true);
        after.Select(s => s.GetProperty("installed").GetBoolean()).Should().Equal(false, true, true);
    }

    [Fact]
    public async Task Reorder_KeepsTheOwnersNamesAndChoices()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 2, ("com.a.um", "Um"), ("com.b.dois", "Dois"));
        (await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{IdsOf(list, "com.a.um").Single()}", new { customLabel = "Sala" })).Dispose();

        (await PutOrderAsync(app, IdsOf(list, "com.b.dois", "com.a.um"))).Dispose();

        var after = await ListAsync(app);
        after[1].GetProperty("customLabel").GetString().Should().Be("Sala");
        after.Should().OnlyContain(s => s.GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Reorder_WithTheSameOrder_Returns200AndWritesNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 2, ("com.a.um", "Um"), ("com.b.dois", "Dois"));
        var before = await app.TvFingerprintAsync();

        using var response = await PutOrderAsync(app, IdsOf(list, "com.a.um", "com.b.dois"));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        Packages((await TvApp.JsonAsync(response)).EnumerateArray().Select(e => e.Clone()).ToList()).Should().Equal("com.a.um", "com.b.dois");
        (await app.TvFingerprintAsync()).Should().Be(before, "nem os atalhos nem a trilha mudam quando a ordem já era essa");
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("unknown-extra")]
    [InlineData("unknown-instead")]
    [InlineData("repeated")]
    [InlineData("empty")]
    [InlineData("too-many")]
    public async Task Reorder_WithAListThatIsNotAnExactPermutation_Returns400_AndChangesNothing(string kind)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 3, ("com.a.um", "Um"), ("com.b.dois", "Dois"), ("com.c.tres", "Três"));
        var all = IdsOf(list, "com.c.tres", "com.b.dois", "com.a.um");
        var before = await app.TvFingerprintAsync();

        Guid[] ids = kind switch
        {
            "missing" => [all[0], all[1]],
            "unknown-extra" => [.. all, Guid.NewGuid()],
            "unknown-instead" => [all[0], Guid.NewGuid(), all[2]],
            "repeated" => [all[0], all[0], all[2]],
            "empty" => [],
            _ => [.. Enumerable.Range(0, 2001).Select(_ => Guid.NewGuid())],
        };
        using var response = await PutOrderAsync(app, ids);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        response.Content.Headers.ContentType!.MediaType.Should().Be("application/problem+json");
        (await TvApp.JsonAsync(response)).GetProperty("errors").GetProperty("ids").GetArrayLength().Should().BeGreaterThan(0);
        Packages(await ListAsync(app)).Should().Equal("com.a.um", "com.b.dois", "com.c.tres");
        (await app.TvFingerprintAsync()).Should().Be(before, "a recusa não grava meia ordem nem deixa rastro na trilha");
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"ids\":null}")]
    [InlineData("{\"ids\":[\"não é um guid\"]}")]
    public async Task Reorder_WithAnUnusableBody_Returns400(string json)
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var request = new HttpRequestMessage(HttpMethod.Put, OrderUrl)
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", app.Login.AccessToken);
        using var response = await app.Client.SendAsync(request, Ct);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Reorder_IsOnlyForTheOwner_AGuestGets403_AndNoOneAnonymousGets401()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 2, ("com.a.um", "Um"), ("com.b.dois", "Dois"));
        var reversed = IdsOf(list, "com.b.dois", "com.a.um");
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var before = await app.TvFingerprintAsync();

        using var asGuest = await PutOrderAsync(app, reversed, bearer: guest.Login.AccessToken);
        using var anonymous = await PutOrderAsync(app, reversed, bearer: null);

        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        Packages(await ListAsync(app)).Should().Equal("com.a.um", "com.b.dois");
        (await app.TvFingerprintAsync()).Should().Be(before);
    }

    [Fact]
    public async Task Reorder_PublishesTheNewListOnTheStream_AndANoOpPublishesNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 3, ("com.a.um", "Um"), ("com.b.dois", "Dois"), ("com.c.tres", "Três"));
        var ticket = await app.StreamTicketAsync();
        using var response = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));
        (await reader.NextAsync())!.EventType.Should().Be("tv.state");
        (await reader.NextAsync())!.EventType.Should().Be("tv.shortcuts");

        (await PutOrderAsync(app, IdsOf(list, "com.c.tres", "com.a.um", "com.b.dois"))).Dispose();

        var frame = (await reader.NextAsync())!;
        frame.EventType.Should().Be("tv.shortcuts");
        frame.Data!.Value.EnumerateArray().Select(s => s.GetProperty("package").GetString()).Should().Equal("com.c.tres", "com.a.um", "com.b.dois");

        // Pedir a mesma ordem de novo não empurra lista nenhuma: o próximo quadro é o estado que o agente manda.
        (await PutOrderAsync(app, IdsOf(list, "com.c.tres", "com.a.um", "com.b.dois"))).Dispose();
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(power: "on", volume: 30)));
        (await reader.NextAsync())!.EventType.Should().Be("tv.state");
    }

    [Fact]
    public async Task Reorder_LeavesAnAuditRow_WithWhoAndHowMany_AndNoAgent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 3, ("com.a.um", "Um"), ("com.b.dois", "Dois"), ("com.c.tres", "Três"));

        (await PutOrderAsync(app, IdsOf(list, "com.c.tres", "com.b.dois", "com.a.um"))).Dispose();

        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.shortcuts.reorder");
        row.Detail.Should().Be("count=3");
        row.Ok.Should().BeTrue();
        row.AgentId.Should().BeNull("a ordem não passa pelo agente");
        row.Ip.Should().Be(TvApp.ClientIp);
        row.UserAgent.Should().Be(TvApp.UserAgentText);
        row.UserId.Should().NotBeEmpty();
        row.OccurredAt.Should().Be(app.Time.GetUtcNow());
    }

    [Fact]
    public async Task ANewListFromTheAgent_KeepsTheOwnersOrder_PutsNewAppsAtTheEnd_AndAnAppThatComesBackKeepsItsSlot()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 3, ("com.a.um", "Um"), ("com.b.dois", "Dois"), ("com.c.tres", "Três"));
        (await PutOrderAsync(app, IdsOf(list, "com.c.tres", "com.a.um", "com.b.dois"))).Dispose();

        // Lista nova (v1): outra ordem, sem o "com.a.um" e com um app que nunca existiu.
        var withNew = await SendAppsAsync(app, agent, 4, ("com.z.novo", "Novo"), ("com.b.dois", "Dois"), ("com.c.tres", "Três"));
        Packages(withNew).Should().Equal("com.c.tres", "com.a.um", "com.b.dois", "com.z.novo");
        withNew.Select(s => s.GetProperty("position").GetInt32()).Should().Equal(1, 2, 3, 4);
        withNew.Single(s => s.GetProperty("package").GetString() == "com.a.um").GetProperty("installed").GetBoolean().Should().BeFalse();

        // E em v2, com o app de volta: ele reaparece onde o dono o pôs, não no fim.
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", new System.Text.Json.Nodes.JsonObject
        {
            ["apps"] = new System.Text.Json.Nodes.JsonArray(
                new System.Text.Json.Nodes.JsonObject { ["package"] = "com.a.um", ["label"] = "Um" },
                new System.Text.Json.Nodes.JsonObject { ["package"] = "com.z.novo", ["label"] = "Novo" },
                new System.Text.Json.Nodes.JsonObject { ["package"] = "com.c.tres", ["label"] = "Três" },
                new System.Text.Json.Nodes.JsonObject { ["package"] = "com.b.dois", ["label"] = "Dois" }),
            ["at"] = "2026-10-20T12:00:00Z",
        }));
        await TvApp.WaitUntilAsync(async () =>
            (await ListAsync(app)).Single(s => s.GetProperty("package").GetString() == "com.a.um").GetProperty("installed").GetBoolean(),
            "app de volta");

        Packages(await ListAsync(app)).Should().Equal("com.c.tres", "com.a.um", "com.b.dois", "com.z.novo");
    }

    [Fact]
    public async Task Reorder_PastTheConfiguredLimit_Returns429()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { CommandsPermitted = 2 });
        await using var agent = await app.ConnectAndWaitAsync();
        var list = await SendAppsAsync(app, agent, 2, ("com.a.um", "Um"), ("com.b.dois", "Dois"));
        var ids = IdsOf(list, "com.b.dois", "com.a.um");

        // As listagens (GET) não contam: o limite é do balde de comandos, e só o PUT entra nele.
        for (var i = 0; i < 2; i++)
        {
            using var allowed = await PutOrderAsync(app, ids);
            allowed.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var limited = await PutOrderAsync(app, ids);

        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        limited.Headers.RetryAfter.Should().NotBeNull();
    }
}
