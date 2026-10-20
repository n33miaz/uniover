using System.Net;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Messaging;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class StateAndMessagesTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<int> OutboxCountAsync(TvApp app)
    {
        await using var db = app.Db();
        return await db.Set<OutboxMessage>().CountAsync(Ct);
    }

    private static async Task<string> StateRowAsync(TvApp app)
    {
        await using var db = app.Db();
        var row = await db.States.AsNoTracking().SingleOrDefaultAsync(Ct);
        return row is null ? "nenhuma" : $"{row.AgentId}|{row.Power}|{row.App}|{row.Connection}";
    }

    [Fact]
    public async Task State_FromTheAgent_ShowsUpInTheApi_WithTheVolumeOnlyInMemory()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(volume: 37)));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var response = await app.GetAsync("/api/v1/tv/state");
            return (await TvApp.JsonAsync(response)).GetProperty("power").GetString() == "on";
        }, "estado visível");

        using var state = await app.GetAsync("/api/v1/tv/state");
        var body = await TvApp.JsonAsync(state);
        body.GetProperty("power").GetString().Should().Be("on");
        body.GetProperty("volume").GetInt32().Should().Be(37);
        body.GetProperty("app").GetString().Should().Be("com.exemplo.video");
        body.GetProperty("connection").GetString().Should().Be("hot");
        body.GetProperty("agentOnline").GetBoolean().Should().BeTrue();

        // Depois da espera da gravação: só power, app e connection vão para o banco; o volume não tem coluna.
        await app.AdvanceUntilAsync(async () => await StateRowAsync(app) != "nenhuma", "estado gravado");
        (await StateRowAsync(app)).Should().Be($"{TvApp.AgentSlug}|on|com.exemplo.video|hot");
        await using var db = app.Db();
        typeof(UniOver.Modules.Tv.Domain.TvStateRecord).GetProperties().Select(p => p.Name).Should().NotContain("Volume");
        (await db.States.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task State_Change_PublishesTheIntegrationEvent_ToASubscriber_ThroughTheOutbox()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody()));
        await app.AdvanceUntilAsync(async () => await OutboxCountAsync(app) == 1, "evento na outbox");
        await app.WaitForOutboxAsync(1);

        await TvApp.WaitUntilAsync(() => !app.Events.States.IsEmpty, "assinante recebeu");
        var received = app.Events.States.Single();
        received.Type.Should().Be("tv.state-changed.v1");
        received.AgentId.Should().Be(TvApp.AgentSlug);
        received.Power.Should().Be("on");
        received.App.Should().Be("com.exemplo.video");
        received.Connection.Should().Be("hot");
    }

    [Fact]
    public async Task State_WhereOnlyTheVolumeChanges_WritesNothingAndPublishesNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(volume: 10)));
        await app.AdvanceUntilAsync(async () => await StateRowAsync(app) != "nenhuma", "primeira gravação");
        await app.WaitForOutboxAsync(1);
        var before = await app.TvFingerprintAsync();

        foreach (var volume in new[] { 11, 12, 40, 41 })
        {
            await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(volume: volume)));
        }

        // O volume já é o novo na API, mas o banco continua exatamente igual (nenhuma escrita, nenhum evento).
        await TvApp.WaitUntilAsync(async () =>
        {
            using var response = await app.GetAsync("/api/v1/tv/state");
            return (await TvApp.JsonAsync(response)).GetProperty("volume").GetInt32() == 41;
        }, "volume novo em memória");
        await app.SettleAsync();

        (await app.TvFingerprintAsync()).Should().Be(before);
        (await OutboxCountAsync(app)).Should().Be(1);
    }

    [Fact]
    public async Task State_ThatFlickersAndComesBack_DoesNotWriteAgain()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(power: "on")));
        await app.AdvanceUntilAsync(async () => await StateRowAsync(app) != "nenhuma", "primeira gravação");
        await app.WaitForOutboxAsync(1);
        var before = await app.TvFingerprintAsync();

        // Desliga e liga de novo antes da gravação: o que sobra é o mesmo estado que já está gravado.
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(power: "off")));
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(power: "on")));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var response = await app.GetAsync("/api/v1/tv/state");
            return (await TvApp.JsonAsync(response)).GetProperty("power").GetString() == "on";
        }, "estado de volta");
        await app.SettleAsync();

        (await app.TvFingerprintAsync()).Should().Be(before);
    }

    [Fact]
    public async Task State_AlreadyStored_AfterARestart_IsNotWrittenOrPublishedAgain()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        // A linha já existe com os mesmos valores (a API acabou de acordar e a memória está vazia).
        await app.ExecuteSqlAsync(
            "INSERT INTO tv.tv_state (agent_id, power, app, connection, updated_at) " +
            $"VALUES ('{TvApp.AgentSlug}', 'on', 'com.exemplo.video', 'hot', now())");
        var before = await app.TvFingerprintAsync();

        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(power: "on", app: "com.exemplo.video", connection: "hot")));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var response = await app.GetAsync("/api/v1/tv/state");
            return (await TvApp.JsonAsync(response)).GetProperty("power").GetString() == "on";
        }, "estado visível");
        await app.SettleAsync();

        (await app.TvFingerprintAsync()).Should().Be(before);
        (await OutboxCountAsync(app)).Should().Be(0);
    }

    [Fact]
    public async Task State_FromAnotherPairedAgent_IsIgnored()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var other = await app.PairAsync("PC Trabalho");
        await using var intruder = await app.ConnectAsync(other);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(other.Slug)?.Connected == true, "outro conectado");

        await intruder.SendTextAsync(intruder.Envelope("tv.state.v1", TvApp.StateBody(power: "off")));
        await intruder.SendTextAsync(intruder.Envelope("tv.apps.v1", TvApp.AppsBody(("com.estranho.app", "Estranho"))));
        await TvApp.WaitUntilAsync(() => app.Presence.Get(other.Slug)?.LastMessageAt is not null, "mensagens lidas");
        await app.SettleAsync();

        using var state = await app.GetAsync("/api/v1/tv/state");
        (await TvApp.JsonAsync(state)).GetProperty("power").GetString().Should().Be("unknown");
        await using var db = app.Db();
        (await db.Shortcuts.CountAsync(Ct)).Should().Be(0);
        (await db.States.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task WhenTheAgentDrops_ConnectionBecomesDisconnected_WithoutAnyDatabaseWrite()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody()));
        await app.AdvanceUntilAsync(async () => await StateRowAsync(app) != "nenhuma", "estado gravado");
        await app.WaitForOutboxAsync(1);
        var before = await app.TvFingerprintAsync();

        await agent.DisposeAsync();
        await TvApp.WaitUntilAsync(() => app.Presence.Get(TvApp.AgentSlug)?.Connected == false, "agente caiu");

        using var state = await app.GetAsync("/api/v1/tv/state");
        var body = await TvApp.JsonAsync(state);
        body.GetProperty("connection").GetString().Should().Be("disconnected");
        body.GetProperty("agentOnline").GetBoolean().Should().BeFalse();
        (await StateRowAsync(app)).Should().EndWith("|hot", "o estado gravado é o último que o agente reportou");
        (await app.TvFingerprintAsync()).Should().Be(before);
    }

    [Fact]
    public async Task Apps_FromTheAgent_CreateShortcutsByPosition_AndASecondListKeepsTheOwnersLabel()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        await agent.SendTextAsync(agent.Envelope(
            "tv.apps.v1", TvApp.AppsBody(("com.a.um", "Um"), ("com.b.dois", null), ("com.c.tres", "Três"))));
        var list = await WaitShortcutsAsync(app, 3);

        list.Select(s => s.GetProperty("position").GetInt32()).Should().Equal(1, 2, 3);
        list.Select(s => s.GetProperty("package").GetString()).Should().Equal("com.a.um", "com.b.dois", "com.c.tres");
        list.Select(s => s.GetProperty("tvLabel").GetString()).Should().Equal("Um", null, "Três");
        list.Should().OnlyContain(s => s.GetProperty("customLabel").ValueKind == System.Text.Json.JsonValueKind.Null);
        list.Should().OnlyContain(s => s.GetProperty("enabled").GetBoolean() && s.GetProperty("installed").GetBoolean());

        // O dono dá nome ao segundo atalho.
        var secondId = list[1].GetProperty("id").GetGuid();
        using var patch = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{secondId}", new { customLabel = "Meu streaming" });
        patch.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(patch)).GetProperty("customLabel").GetString().Should().Be("Meu streaming");

        // A TV manda a lista de novo, em outra ordem, sem o terceiro app e com um novo.
        await agent.SendTextAsync(agent.Envelope(
            "tv.apps.v1", TvApp.AppsBody(("com.b.dois", "Dois novo"), ("com.a.um", "Um"), ("com.d.quatro", "Quatro"))));
        var again = await WaitShortcutsAsync(app, 4);

        again.Select(s => s.GetProperty("package").GetString()).Should().Equal("com.a.um", "com.b.dois", "com.c.tres", "com.d.quatro");
        var second = again.Single(s => s.GetProperty("package").GetString() == "com.b.dois");
        second.GetProperty("customLabel").GetString().Should().Be("Meu streaming");
        second.GetProperty("position").GetInt32().Should().Be(2);
        second.GetProperty("tvLabel").GetString().Should().Be("Dois novo");
        var gone = again.Single(s => s.GetProperty("package").GetString() == "com.c.tres");
        gone.GetProperty("enabled").GetBoolean().Should().BeFalse("o app sumiu da lista");
        gone.GetProperty("installed").GetBoolean().Should().BeFalse("o app sumiu da lista");
        again.Single(s => s.GetProperty("package").GetString() == "com.d.quatro").GetProperty("position").GetInt32().Should().Be(4);
    }

    [Fact]
    public async Task Shortcut_Launch_OpensAnyInstalledApp_EvenOneTheOwnerTookOffTheRemote_AndRefusesOnlyUninstalledOrUnknownOnes()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope(
            "tv.apps.v1", TvApp.AppsBody(("com.a.um", "Um"), ("com.b.dois", "Dois"), ("com.c.tres", "Três"))));
        var list = await WaitShortcutsAsync(app, 3);
        var first = list[0].GetProperty("id").GetGuid();
        var second = list[1].GetProperty("id").GetGuid();
        var third = list[2].GetProperty("id").GetGuid();

        // O pacote que vai à TV é o que o agente informou, nunca texto da requisição.
        await LaunchAndExpectPackageAsync(app, agent, first, "com.a.um");

        // O dono tira o segundo do controle: ele segue instalado (o DTO diz as duas coisas) e continua abrindo.
        using (var patch = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{second}", new { enabled = false }))
        {
            var updated = await TvApp.JsonAsync(patch);
            updated.GetProperty("enabled").GetBoolean().Should().BeFalse();
            updated.GetProperty("installed").GetBoolean().Should().BeTrue();
        }

        await LaunchAndExpectPackageAsync(app, agent, second, "com.b.dois");

        // O terceiro some da lista da TV: fica desinstalado e o lançamento é recusado, sem nada ir ao agente.
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.a.um", "Um"), ("com.b.dois", "Dois"))));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var response = await app.GetAsync("/api/v1/tv/shortcuts");
            var items = (await TvApp.JsonAsync(response)).EnumerateArray().Select(e => e.Clone()).ToList();
            return items.Single(s => s.GetProperty("id").GetGuid() == third).GetProperty("installed").GetBoolean() == false;
        }, "terceiro app desinstalado");
        using var gone = await app.PostAsync($"/api/v1/tv/shortcuts/{third}/launch");
        gone.StatusCode.Should().Be(HttpStatusCode.Conflict);

        using var missing = await app.PostAsync($"/api/v1/tv/shortcuts/{Guid.NewGuid()}/launch");
        missing.StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Só os dois lançamentos que saíram foram auditados.
        await using var db = app.Db();
        (await db.CommandAudit.Where(a => a.Command == "tv.app.launch").Select(a => a.Detail).ToListAsync(Ct))
            .Should().BeEquivalentTo("com.a.um", "com.b.dois");
    }

    private static async Task LaunchAndExpectPackageAsync(TvApp app, FakeAgent agent, Guid id, string package)
    {
        var launch = app.PostAsync($"/api/v1/tv/shortcuts/{id}/launch");
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.app.launch.v1");
        command.GetProperty("body").GetRawText().Should().Be($"{{\"target\":{{\"kind\":\"package\",\"value\":\"{package}\"}}}}");
        await TvApp.ReplyAsync(agent, command);
        using var ok = await launch.WaitAsync(FakeAgent.Patience, Ct);
        ok.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Shortcut_Update_Validates_AndUnknownIdsAre404()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var empty = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{Guid.NewGuid()}", new { });
        empty.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        using var missing = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{Guid.NewGuid()}", new { enabled = true });
        missing.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task RefreshShortcuts_AsksTheAgentForTheApps()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/shortcuts/refresh");
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.apps.refresh.v1");
        await TvApp.ReplyAsync(agent, command);

        using var response = await request.WaitAsync(FakeAgent.Patience, Ct);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).Command.Should().Be("tv.apps.refresh");
    }

    [Fact]
    public async Task Watchdog_FromTheAgent_IsStored_AndPublished()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        await agent.SendTextAsync(agent.Envelope("tv.watchdog.v1", new JsonObject
        {
            ["kind"] = "repair_failed",
            ["severity"] = "error",
            ["detail"] = "porta 5555 fechada",
            ["attempts"] = 3,
            ["at"] = "2026-10-19T12:00:00Z",
        }));

        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.WatchdogEvents.AnyAsync(Ct);
        }, "evento do vigia gravado");
        await using var verify = app.Db();
        var row = await verify.WatchdogEvents.SingleAsync(Ct);
        row.AgentId.Should().Be(TvApp.AgentSlug);
        row.Kind.Should().Be("repair_failed");
        row.Severity.Should().Be("error");
        row.Detail.Should().Be("porta 5555 fechada");
        row.Attempts.Should().Be(3);
        row.OccurredAt.Should().Be(DateTimeOffset.Parse("2026-10-19T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));

        await app.WaitForOutboxAsync(1);
        await TvApp.WaitUntilAsync(() => !app.Events.Watchdogs.IsEmpty, "assinante recebeu");
        var published = app.Events.Watchdogs.Single();
        published.Type.Should().Be("tv.watchdog-recorded.v1");
        published.Kind.Should().Be("repair_failed");
        published.Attempts.Should().Be(3);
    }

    [Fact]
    public async Task Watchdog_KeepsOnlyTheLast500Rows()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await app.ExecuteSqlAsync(
            "INSERT INTO tv.watchdog_events (id, agent_id, kind, severity, detail, attempts, occurred_at, received_at) " +
            "SELECT gen_random_uuid(), 'pc-casa', 'recovered', 'info', 'x', 0, now() - interval '1 day', now() - (g * interval '1 second') - interval '1 hour' FROM generate_series(1, 520) g");

        await agent.SendTextAsync(agent.Envelope("tv.watchdog.v1", new JsonObject
        {
            ["kind"] = "recovered", ["severity"] = "info", ["detail"] = "ok", ["attempts"] = 0, ["at"] = "2026-10-19T12:00:00Z",
        }));

        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.WatchdogEvents.AnyAsync(w => w.Detail == "ok", Ct) && await db.WatchdogEvents.CountAsync(Ct) <= 500;
        }, "retenção do vigia");
    }

    private static async Task<List<System.Text.Json.JsonElement>> WaitShortcutsAsync(TvApp app, int count)
    {
        List<System.Text.Json.JsonElement> list = [];
        await TvApp.WaitUntilAsync(async () =>
        {
            using var response = await app.GetAsync("/api/v1/tv/shortcuts");
            list = (await TvApp.JsonAsync(response)).EnumerateArray().Select(e => e.Clone()).ToList();
            return list.Count == count;
        }, $"{count} atalhos");
        return list;
    }
}
