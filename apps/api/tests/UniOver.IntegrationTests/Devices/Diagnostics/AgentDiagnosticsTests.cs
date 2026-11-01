using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Domain;
using UniOver.SharedKernel;

namespace UniOver.IntegrationTests.Devices.Diagnostics;

/// <summary>
/// Os diagnósticos que o agente conta sobre si mesmo: gravação pelo canal real, reenvio sem duplicar, retenção por tempo e
/// por quantidade, limite por hora e leitura só pelo dono. Host real, Postgres real e relógio falso.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class AgentDiagnosticsTests(PostgresFixture postgres)
{
    private const string Url = "/api/v1/devices/agents/diagnostics";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static JsonObject Event(Guid id, DateTimeOffset at, string kind = "background.failed", string severity = "error", string detail = "TimeoutError em session.py:watch", int? count = null)
    {
        var item = new JsonObject
        {
            ["id"] = id.ToString(),
            ["at"] = at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture),
            ["kind"] = kind,
            ["severity"] = severity,
            ["component"] = "tv.session",
            ["detail"] = detail,
        };
        if (count is { } repeated)
        {
            item["count"] = repeated;
        }

        return item;
    }

    private static JsonObject Batch(params JsonObject[] events) => new() { ["events"] = new JsonArray([.. events.Select(e => (JsonNode)e)]) };

    private static async Task<int> CountAsync(TransportApp app)
    {
        await using var db = app.App.Db();
        return await db.AgentDiagnosticEvents.CountAsync(Ct);
    }

    private static async Task WaitForCountAsync(TransportApp app, int expected) =>
        await TransportApp.WaitUntilAsync(async () => await CountAsync(app) == expected, $"{expected} diagnósticos gravados");

    private static async Task<JsonElement> ReadAsync(TransportApp app, string query = "")
    {
        var owner = await app.App.LoginAsync();
        using var response = await app.App.SendAsync(HttpMethod.Get, Url + query, bearer: owner.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl!.NoStore.Should().BeTrue();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
    }

    [Fact]
    public async Task ABatchIsStored_AndTheOwnerReadsItNewestFirstWithTheAgentName()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var now = app.App.Time.GetUtcNow();

        var older = Event(Guid.NewGuid(), now.AddMinutes(-10), detail: "primeiro", count: 3);
        var newer = Event(Guid.NewGuid(), now.AddMinutes(-1), kind: "repair.done", severity: "info", detail: "segundo");
        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(older, newer)));
        await WaitForCountAsync(app, 2);

        var json = await ReadAsync(app);
        json.GetProperty("retentionDays").GetInt32().Should().Be(7);
        var items = json.GetProperty("items").EnumerateArray().ToList();
        items.Select(i => i.GetProperty("detail").GetString()).Should().Equal("segundo", "primeiro");
        items[0].GetProperty("agentName").GetString().Should().Be("PC Casa");
        items[0].GetProperty("agentId").GetGuid().Should().Be(app.Agent.Id);
        items[0].GetProperty("kind").GetString().Should().Be("repair.done");
        items[0].GetProperty("severity").GetString().Should().Be("info");
        items[1].GetProperty("count").GetInt32().Should().Be(3);
        items[1].GetProperty("component").GetString().Should().Be("tv.session");
        agent.State.Should().Be(WebSocketState.Open);
    }

    [Fact]
    public async Task ResendingTheSameBatchStoresNothingTwice()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var first = Event(Guid.NewGuid(), app.App.Time.GetUtcNow());
        var batch = Batch(first);

        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", batch));
        await WaitForCountAsync(app, 1);
        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", batch));
        var marker = Event(Guid.NewGuid(), app.App.Time.GetUtcNow(), detail: "marcador");
        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch((JsonObject)first.DeepClone(), marker)));

        // O marcador entra e o repetido não: o reenvio é processado em ordem, então 2 é o total final.
        await WaitForCountAsync(app, 2);
        await Task.Delay(200, Ct);
        (await CountAsync(app)).Should().Be(2);
    }

    [Fact]
    public async Task AnAgentClockOutOfReachIsReplacedByTheReceiveTime()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var now = app.App.Time.GetUtcNow();
        var future = Guid.NewGuid();
        var ancient = Guid.NewGuid();
        var fine = Guid.NewGuid();

        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(
            Event(future, now.AddHours(3)),
            Event(ancient, now.AddDays(-30)),
            Event(fine, now.AddMinutes(-20)))));
        await WaitForCountAsync(app, 3);

        await using var db = app.App.Db();
        var rows = await db.AgentDiagnosticEvents.ToDictionaryAsync(e => e.EventId, Ct);
        rows[future].At.Should().BeCloseTo(now, TimeSpan.FromSeconds(2));
        rows[ancient].At.Should().BeCloseTo(now, TimeSpan.FromSeconds(2));
        rows[fine].At.Should().BeCloseTo(now.AddMinutes(-20), TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task RetentionByTimeDropsWhatIsOlderThanSevenDays_WhenTheNextBatchArrives()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(Event(Guid.NewGuid(), app.App.Time.GetUtcNow(), detail: "velho"))));
        await WaitForCountAsync(app, 1);

        app.App.Time.Advance(TimeSpan.FromDays(8));
        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(Event(Guid.NewGuid(), app.App.Time.GetUtcNow(), detail: "novo"))));

        await TransportApp.WaitUntilAsync(async () =>
        {
            await using var db = app.App.Db();
            return await db.AgentDiagnosticEvents.AnyAsync(e => e.Detail == "novo", Ct)
                && !await db.AgentDiagnosticEvents.AnyAsync(e => e.Detail == "velho", Ct);
        }, "o velho sair e o novo entrar");
    }

    [Fact]
    public async Task RetentionByCountKeepsOnlyTheNewestThreeHundredPerAgent()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var now = app.App.Time.GetUtcNow();
        await using (var seed = app.App.Db())
        {
            for (var i = 0; i < 305; i++)
            {
                seed.AgentDiagnosticEvents.Add(AgentDiagnosticEvent.Create(
                    IdGenerator.NewId(), app.Agent.Id, Guid.NewGuid(), now.AddMinutes(-400 + i), now.AddDays(-1), "check.failed", "warn", null, $"semente {i}", 1));
            }

            await seed.SaveChangesAsync(Ct);
        }

        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(Event(Guid.NewGuid(), now, detail: "o mais novo"))));

        await TransportApp.WaitUntilAsync(async () => await CountAsync(app) == 300, "poda para 300");
        await using var db = app.App.Db();
        (await db.AgentDiagnosticEvents.AnyAsync(e => e.Detail == "o mais novo", Ct)).Should().BeTrue();
        (await db.AgentDiagnosticEvents.AnyAsync(e => e.Detail == "semente 0", Ct)).Should().BeFalse("o mais antigo sai primeiro");
        (await db.AgentDiagnosticEvents.AnyAsync(e => e.Detail == "semente 304", Ct)).Should().BeTrue();
    }

    [Fact]
    public async Task MoreThanTwoHundredAnHourIsDropped_WithASingleWarningPerHour()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var now = app.App.Time.GetUtcNow();

        // 11 lotes de 20 = 220 numa hora: entram 200, e o excedente vira um aviso só.
        for (var batch = 0; batch < 11; batch++)
        {
            var events = Enumerable.Range(0, 20).Select(i => Event(Guid.NewGuid(), now, detail: $"lote {batch} item {i}")).ToArray();
            await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(events)));
        }

        await WaitForCountAsync(app, 201);
        await Task.Delay(300, Ct);
        await using (var db = app.App.Db())
        {
            (await db.AgentDiagnosticEvents.CountAsync(e => e.Kind == "diagnostics.dropped", Ct)).Should().Be(1);
            (await db.AgentDiagnosticEvents.CountAsync(e => e.Kind == "background.failed", Ct)).Should().Be(200);
        }

        // Passada a hora o agente volta a ser ouvido.
        app.App.Time.Advance(TimeSpan.FromMinutes(61));
        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(Event(Guid.NewGuid(), app.App.Time.GetUtcNow(), detail: "depois da hora"))));
        await TransportApp.WaitUntilAsync(async () =>
        {
            await using var db = app.App.Db();
            return await db.AgentDiagnosticEvents.AnyAsync(e => e.Detail == "depois da hora", Ct);
        }, "evento depois da hora");
    }

    [Fact]
    public async Task OnlyTheOwnerReads_AndTheLimitIsChecked()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var owner = await app.App.LoginAsync();
        var guest = await app.App.NewGuestAsync();
        var guestLogin = await app.App.LoginAsync(guest);

        using var anonymous = await app.App.SendAsync(HttpMethod.Get, Url);
        using var asGuest = await app.App.SendAsync(HttpMethod.Get, Url, bearer: guestLogin.AccessToken);
        using var empty = await app.App.SendAsync(HttpMethod.Get, Url, bearer: owner.AccessToken);
        using var zero = await app.App.SendAsync(HttpMethod.Get, Url + "?limit=0", bearer: owner.AccessToken);
        using var tooMany = await app.App.SendAsync(HttpMethod.Get, Url + "?limit=101", bearer: owner.AccessToken);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        empty.StatusCode.Should().Be(HttpStatusCode.OK);
        (await empty.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("items").GetArrayLength().Should().Be(0);
        zero.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        tooMany.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task TheLimitCutsTheListAndRevokedAgentsDisappear()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var now = app.App.Time.GetUtcNow();
        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(
            Event(Guid.NewGuid(), now.AddMinutes(-3), detail: "a"),
            Event(Guid.NewGuid(), now.AddMinutes(-2), detail: "b"),
            Event(Guid.NewGuid(), now.AddMinutes(-1), detail: "c"))));
        await WaitForCountAsync(app, 3);

        var limited = await ReadAsync(app, "?limit=2");
        limited.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("detail").GetString()).Should().Equal("c", "b");

        await using (var db = app.App.Db())
        {
            var row = await db.Agents.SingleAsync(a => a.Id == app.Agent.Id, Ct);
            row.Revoke(app.App.Time.GetUtcNow(), Guid.NewGuid(), null);
            await db.SaveChangesAsync(Ct);
        }

        (await ReadAsync(app)).GetProperty("items").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task AnOutOfContractBatchIsRefused_NothingIsStored_AndTheConnectionSurvives()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var bad = Event(Guid.NewGuid(), app.App.Time.GetUtcNow(), kind: "Bad Kind/../x");

        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(bad)));
        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", new JsonObject { ["events"] = new JsonArray() }));
        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", Batch(Event(Guid.NewGuid(), app.App.Time.GetUtcNow(), detail: "valido"))));

        await WaitForCountAsync(app, 1);
        await using var db = app.App.Db();
        (await db.AgentDiagnosticEvents.SingleAsync(Ct)).Detail.Should().Be("valido");
        agent.State.Should().Be(WebSocketState.Open);
    }
}
