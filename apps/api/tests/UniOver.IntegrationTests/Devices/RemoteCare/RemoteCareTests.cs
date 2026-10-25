using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Devices.RemoteCare;

/// <summary>
/// Manutenção remota de um agente (só o dono): o registro do agente, "Atualizar agora" e "Reiniciar o agente", com um
/// agente simulado do outro lado do canal.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class RemoteCareTests(PostgresFixture postgres)
{
    private const string Logs = "agent.logs.v1";
    private const string Maintenance = "agent.maintenance.v1";
    private const string StepUpAction = "devices.agent-maintenance";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string LogsUrl(TransportApp app) => $"/api/v1/devices/agents/{app.Agent.Id}/logs";

    private static string MaintenanceUrl(TransportApp app) => $"/api/v1/devices/agents/{app.Agent.Id}/maintenance";

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    private static Task<FakeAgent> ConnectAsync(TransportApp app, params string[] capabilities) =>
        ConnectWithUpdateAsync(app, null, capabilities);

    private static async Task<FakeAgent> ConnectWithUpdateAsync(TransportApp app, JsonObject? update, params string[] capabilities)
    {
        var agent = await app.ConnectAsync();
        var hello = new JsonObject
        {
            ["agentVersion"] = "0.1.0+3f2a9c1d4e5b",
            ["capabilities"] = new JsonArray([.. capabilities.Select(c => (JsonNode)JsonValue.Create(c)!)]),
            ["os"] = "Windows 11 (10.0.26200)",
            ["tv"] = new JsonObject { ["kind"] = "android", ["host"] = "192.168.0.20" },
        };
        if (update is not null)
        {
            hello["update"] = update;
        }

        await agent.SendTextAsync(agent.Envelope("agent.hello.v1", hello));
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.AgentVersion is not null, "hello processado");
        return agent;
    }

    private static JsonObject Ok() => new() { ["ok"] = true };

    private static JsonObject Failed(string code) =>
        new() { ["ok"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = "texto livre do agente" } };

    private static JsonObject LogsBody(Guid requestId, string text, bool truncated = false) => new()
    {
        ["requestId"] = requestId.ToString(),
        ["text"] = text,
        ["lines"] = text.Split('\n').Length,
        ["truncated"] = truncated,
        ["at"] = "2026-10-24T14:00:01Z",
    };

    /// <summary>O agente simulado recebe o pedido do registro e responde como o de verdade: o quadro e depois o resultado.</summary>
    private static async Task<JsonElement> AnswerLogsAsync(FakeAgent agent, string text, bool truncated = false)
    {
        var command = (await agent.ReceiveAsync())!.Value;
        var requestId = command.GetProperty("body").GetProperty("requestId").GetGuid();
        var commandId = command.GetProperty("id").GetGuid();
        await agent.SendTextAsync(agent.Envelope(Logs, LogsBody(requestId, text, truncated), commandId));
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Ok(), commandId));
        return command;
    }

    private static async Task<(DevicesApp, VirtualAuthenticator)> WithPasskeyAsync(TransportApp app)
    {
        var authenticator = new VirtualAuthenticator();
        await app.App.RegisterPasskeyAsync(app.Login, authenticator);
        return (app.App, authenticator);
    }

    // ---- registro ----

    [Fact]
    public async Task Logs_ReturnsWhatTheAgentSent_AuditsTheViewAndNeverStoresOrLogsTheText()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Logs, Maintenance);

        var http = app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 50 }, app.Login.AccessToken, userAgent: "painel/1.0");
        var command = await AnswerLogsAsync(agent, "linha um\nlinha dois SEGREDO-DO-REGISTRO");
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl!.NoStore.Should().BeTrue("o registro não pode ficar em cache");
        var body = await DevicesApp.JsonAsync(response);
        body.GetProperty("text").GetString().Should().Be("linha um\nlinha dois SEGREDO-DO-REGISTRO");
        body.GetProperty("lines").GetInt32().Should().Be(2);
        body.GetProperty("truncated").GetBoolean().Should().BeFalse();

        command.GetProperty("type").GetString().Should().Be("agent.logs.request.v1");
        command.GetProperty("target").GetString().Should().Be($"agent:{app.Agent.Slug}");
        command.GetProperty("body").GetProperty("lines").GetInt32().Should().Be(50);
        command.GetProperty("body").EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo("requestId", "lines");

        await using var db = app.App.Db();
        var audit = await db.PairingAudit.SingleAsync(a => a.Event == "agent_logs_viewed", Ct);
        audit.AgentId.Should().Be(app.Agent.Id);
        audit.UserId.Should().NotBeNull();
        audit.UserAgent.Should().Be("painel/1.0");
        app.App.Logs.Lines.Should().NotContain(l => l.Contains("SEGREDO-DO-REGISTRO", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Logs_WithoutALinesField_AsksForThreeHundred()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Logs);

        var http = app.App.SendAsync(HttpMethod.Post, LogsUrl(app), bearer: app.Login.AccessToken);
        var command = await AnswerLogsAsync(agent, "x");
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        command.GetProperty("body").GetProperty("lines").GetInt32().Should().Be(300);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1001)]
    [InlineData(-5)]
    public async Task Logs_WithLinesOutOfRange_Returns400_AndAsksTheAgentNothing(int lines)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Logs);

        using var response = await app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines }, app.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Logs_FromAnAgentWithoutTheCapability_Returns409AgentOutdated()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", "tv.remote");

        using var response = await app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-outdated");
    }

    [Fact]
    public async Task Logs_OfAnOfflineAgent_Returns503_WithoutWaiting()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        using var response = await app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-offline");
    }

    [Fact]
    public async Task Logs_OfARevokedOrUnknownAgent_Returns404()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Logs);

        using var unknown = await app.App.SendAsync(
            HttpMethod.Post, $"/api/v1/devices/agents/{Guid.NewGuid()}/logs", new { lines = 10 }, app.Login.AccessToken);
        (await app.App.RevokeRawAsync(app.Login, app.Agent.Id)).Dispose();
        using var revoked = await app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);

        unknown.StatusCode.Should().Be(HttpStatusCode.NotFound);
        revoked.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Logs_WhenTheAgentNeverAnswers_Returns504()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Logs);

        var http = app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);
        await agent.ReceiveAsync();
        while (!http.IsCompleted)
        {
            app.App.Time.Advance(TimeSpan.FromSeconds(11));
            await Task.Delay(25, Ct);
        }

        using var response = await http;
        response.StatusCode.Should().Be(HttpStatusCode.GatewayTimeout);
    }

    [Fact]
    public async Task Logs_WhenTheAgentCannotRead_Returns502_WithItsStableCodeAndNotItsText()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Logs);

        var http = app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);
        var command = (await agent.ReceiveAsync())!.Value;
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Failed("log_unavailable"), command.GetProperty("id").GetGuid()));
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var problem = await DevicesApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/command-failed");
        problem.GetProperty("agentError").GetString().Should().Be("log_unavailable");
        problem.ToString().Should().NotContain("texto livre do agente");

        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "agent_logs_viewed", Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Logs_WhenTheReportNeverComes_Returns502LogsMissing()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Logs);

        var http = app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);
        var command = (await agent.ReceiveAsync())!.Value;
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Ok(), command.GetProperty("id").GetGuid()));
        while (!http.IsCompleted)
        {
            app.App.Time.Advance(TimeSpan.FromSeconds(3));
            await Task.Delay(25, Ct);
        }

        using var response = await http;
        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/logs-missing");
    }

    [Fact]
    public async Task Logs_ARepeatedRequestWhileOneIsInProgress_Returns409Busy()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Logs);

        var first = app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);
        var command = (await agent.ReceiveAsync())!.Value;
        using var second = await app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);

        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(second)).GetProperty("type").GetString().Should().EndWith("/logs-in-progress");

        // O primeiro segue valendo e termina normalmente.
        var requestId = command.GetProperty("body").GetProperty("requestId").GetGuid();
        var commandId = command.GetProperty("id").GetGuid();
        await agent.SendTextAsync(agent.Envelope(Logs, LogsBody(requestId, "ok"), commandId));
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Ok(), commandId));
        using var done = await Within(first);
        done.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Logs_ARecordFromAnotherAgentWithTheSameRequestId_IsIgnored()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var other = await app.PairAnotherAsync("Outro PC");
        await using var agent = await ConnectAsync(app, Logs);
        await using var impostor = await FakeAgent.ConnectAsync(app.Server, other.Slug, other.Token);
        await impostor.SendHelloAsync("9.9.9", Logs);

        var http = app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);
        var command = (await agent.ReceiveAsync())!.Value;
        var requestId = command.GetProperty("body").GetProperty("requestId").GetGuid();
        var commandId = command.GetProperty("id").GetGuid();

        // O outro agente conhece o requestId (hipótese pior) e manda o registro dele: não vale.
        await impostor.SendTextAsync(impostor.Envelope(Logs, LogsBody(requestId, "TEXTO-DO-OUTRO-PC"), commandId));
        await TransportApp.WaitUntilAsync(
            () => app.App.Logs.Lines.Any(l => l.Contains("ninguém espera", StringComparison.Ordinal)), "registro alheio descartado");
        await agent.SendTextAsync(agent.Envelope(Logs, LogsBody(requestId, "TEXTO-DO-PC-CERTO"), commandId));
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Ok(), commandId));
        using var response = await Within(http);

        (await DevicesApp.JsonAsync(response)).GetProperty("text").GetString().Should().Be("TEXTO-DO-PC-CERTO");
    }

    [Fact]
    public async Task Logs_AreRateLimitedPerAccount()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        for (var i = 0; i < 12; i++)
        {
            using var response = await app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);
            response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        }

        using var limited = await app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, app.Login.AccessToken);
        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task Logs_GuestGets403_AndAnonymousGets401()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Logs, Maintenance);
        var guest = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow());

        using var asGuest = await app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 }, guest.Login.AccessToken);
        using var anonymous = await app.App.SendAsync(HttpMethod.Post, LogsUrl(app), new { lines = 10 });
        using var guestMaintenance = await app.App.SendAsync(HttpMethod.Post, MaintenanceUrl(app), new { action = "restart" }, guest.Login.AccessToken);
        using var anonymousMaintenance = await app.App.SendAsync(HttpMethod.Post, MaintenanceUrl(app), new { action = "restart" });

        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        guestMaintenance.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        anonymousMaintenance.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // ---- manutenção ----

    [Fact]
    public async Task Maintenance_WithoutThePasskeyConfirmation_Returns403StepUpRequired_AndTouchesNothing()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Maintenance);

        using var response = await app.App.SendAsync(
            HttpMethod.Post, MaintenanceUrl(app), new { action = "restart" }, app.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var problem = await DevicesApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/step-up-required");
        problem.GetProperty("action").GetString().Should().Be(StepUpAction);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event.StartsWith("agent_restart") || a.Event.StartsWith("agent_update"), Ct)).Should().Be(0);
    }

    [Theory]
    [InlineData("restart", "agent_restart_requested")]
    [InlineData("update", "agent_update_requested")]
    public async Task Maintenance_AfterThePasskey_TellsTheAgent_AndAudits(string action, string auditEvent)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Maintenance);
        var (devices, authenticator) = await WithPasskeyAsync(app);
        using var _ = authenticator;
        await devices.ConfirmStepUpAsync(app.Login, authenticator, StepUpAction);

        var http = app.App.SendAsync(HttpMethod.Post, MaintenanceUrl(app), new { action }, app.Login.AccessToken);
        var command = (await agent.ReceiveAsync())!.Value;
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Ok(), command.GetProperty("id").GetGuid()));
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await DevicesApp.JsonAsync(response);
        body.GetProperty("action").GetString().Should().Be(action);
        body.GetProperty("accepted").GetBoolean().Should().BeTrue();
        command.GetProperty("type").GetString().Should().Be("agent.maintenance.v1");
        command.GetProperty("body").GetProperty("action").GetString().Should().Be(action);

        await using var db = app.App.Db();
        var audit = await db.PairingAudit.SingleAsync(a => a.Event == auditEvent, Ct);
        audit.AgentId.Should().Be(app.Agent.Id);
        audit.UserId.Should().NotBeNull();
    }

    [Fact]
    public async Task Maintenance_WithAnUnknownAction_Returns400_AfterTheConfirmation()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Maintenance);
        var (devices, authenticator) = await WithPasskeyAsync(app);
        using var _ = authenticator;
        await devices.ConfirmStepUpAsync(app.Login, authenticator, StepUpAction);

        foreach (var action in new object?[] { "format-disk", "", null })
        {
            using var response = await app.App.SendAsync(
                HttpMethod.Post, MaintenanceUrl(app), new { action }, app.Login.AccessToken);
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest, $"ação {action ?? "nula"}");
        }
    }

    [Fact]
    public async Task Maintenance_OnAnOutdatedAgent_Returns409_AndOnAFailureReturns502_WithoutAuditing()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var (devices, authenticator) = await WithPasskeyAsync(app);
        using var _ = authenticator;
        await devices.ConfirmStepUpAsync(app.Login, authenticator, StepUpAction);

        await using (var old = await ConnectAsync(app, "transport.keepalive.v1"))
        {
            using var outdated = await app.App.SendAsync(
                HttpMethod.Post, MaintenanceUrl(app), new { action = "update" }, app.Login.AccessToken);
            outdated.StatusCode.Should().Be(HttpStatusCode.Conflict);
            (await DevicesApp.JsonAsync(outdated)).GetProperty("type").GetString().Should().EndWith("/agent-outdated");
        }

        await using var agent = await ConnectAsync(app, Maintenance);
        var http = app.App.SendAsync(HttpMethod.Post, MaintenanceUrl(app), new { action = "update" }, app.Login.AccessToken);
        var command = (await agent.ReceiveAsync())!.Value;
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Failed("maintenance_unavailable"), command.GetProperty("id").GetGuid()));
        using var failed = await Within(http);

        failed.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await DevicesApp.JsonAsync(failed)).GetProperty("agentError").GetString().Should().Be("maintenance_unavailable");
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "agent_update_requested", Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Maintenance_AConfirmationForAnotherAction_DoesNotCount()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Maintenance);
        var (devices, authenticator) = await WithPasskeyAsync(app);
        using var _ = authenticator;
        await devices.ConfirmApproveAsync(app.Login, authenticator);

        using var response = await app.App.SendAsync(
            HttpMethod.Post, MaintenanceUrl(app), new { action = "restart" }, app.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await DevicesApp.JsonAsync(response)).GetProperty("action").GetString().Should().Be(StepUpAction);
    }

    // ---- lista ----

    [Fact]
    public async Task List_ShowsWhatTheHelloToldAboutTheComputer_AndNothingBeforeIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        using var before = await app.App.SendAsync(HttpMethod.Get, "/api/v1/devices/agents", bearer: app.Login.AccessToken);
        var quiet = (await DevicesApp.JsonAsync(before)).EnumerateArray().Single();
        quiet.GetProperty("connected").GetBoolean().Should().BeFalse();
        quiet.GetProperty("agentVersion").ValueKind.Should().Be(JsonValueKind.Null);
        quiet.GetProperty("canReadLogs").GetBoolean().Should().BeFalse();

        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Logs, Maintenance, "tv.remote", "tv.kind.android");
        using var after = await app.App.SendAsync(HttpMethod.Get, "/api/v1/devices/agents", bearer: app.Login.AccessToken);
        var item = (await DevicesApp.JsonAsync(after)).EnumerateArray().Single();

        item.GetProperty("connected").GetBoolean().Should().BeTrue();
        item.GetProperty("agentVersion").GetString().Should().Be("0.1.0");
        item.GetProperty("agentBuild").GetString().Should().Be("3f2a9c1d4e5b");
        item.GetProperty("os").GetString().Should().Be("Windows 11 (10.0.26200)");
        item.GetProperty("tvKind").GetString().Should().Be("android");
        item.GetProperty("tvHost").GetString().Should().Be("192.168.0.20");
        item.GetProperty("canReadLogs").GetBoolean().Should().BeTrue();
        item.GetProperty("canMaintain").GetBoolean().Should().BeTrue();
        item.GetProperty("lastSeenAt").ValueKind.Should().Be(JsonValueKind.String);
    }

    [Fact]
    public async Task List_ForAnOldAgent_OffersNeitherLogsNorMaintenance()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("0.1.0", "transport.keepalive.v1", "tv.remote");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion is not null, "hello");

        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/devices/agents", bearer: app.Login.AccessToken);
        var item = (await DevicesApp.JsonAsync(response)).EnumerateArray().Single();

        item.GetProperty("agentVersion").GetString().Should().Be("0.1.0");
        item.GetProperty("agentBuild").ValueKind.Should().Be(JsonValueKind.Null);
        item.GetProperty("tvHost").ValueKind.Should().Be(JsonValueKind.Null);
        item.GetProperty("canReadLogs").GetBoolean().Should().BeFalse();
        item.GetProperty("canMaintain").GetBoolean().Should().BeFalse();
    }

    // ---- estado da atualização e volta à versão anterior ----

    private const string Installed = "3f2a9c1d4e5b6a7988776655443322110fedcba9";
    private const string Newer = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    private const string Previous = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

    private static JsonObject UpdateState(string outcome, string? latest = null, string? previous = null, string? reason = null)
    {
        var update = new JsonObject
        {
            ["outcome"] = outcome,
            ["installedSha"] = Installed,
            ["installedAt"] = "2026-10-20T09:15:00Z",
            ["checkedAt"] = "2026-10-24T13:40:00Z",
            ["nextCheckAt"] = "2026-10-24T19:55:00Z",
        };
        if (latest is not null)
        {
            update["latestSha"] = latest;
        }

        if (previous is not null)
        {
            update["previousSha"] = previous;
        }

        if (reason is not null)
        {
            update["reason"] = reason;
        }

        return update;
    }

    private static async Task<JsonElement> ListedAsync(TransportApp app)
    {
        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/devices/agents", bearer: app.Login.AccessToken);
        return (await DevicesApp.JsonAsync(response)).EnumerateArray().Single().Clone();
    }

    [Theory]
    [InlineData("up_to_date", Installed, "current")]
    [InlineData("up_to_date", Newer, "pending")]
    [InlineData("not_checked", null, "unchecked")]
    [InlineData("updating", Newer, "updating")]
    [InlineData("blocked", Newer, "blocked")]
    [InlineData("rolled_back", Newer, "rolled_back")]
    public async Task List_TellsTheUpdateStateTheHelloCarried(string outcome, string? latest, string expectedState)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithUpdateAsync(app, UpdateState(outcome, latest), "transport.keepalive.v1", Maintenance);

        var update = (await ListedAsync(app)).GetProperty("update");

        update.GetProperty("state").GetString().Should().Be(expectedState);
        update.GetProperty("installedSha").GetString().Should().Be(Installed);
        update.GetProperty("installedAt").GetDateTimeOffset().Should().Be(new DateTimeOffset(2026, 10, 20, 9, 15, 0, TimeSpan.Zero));
        update.GetProperty("checkedAt").ValueKind.Should().Be(JsonValueKind.String);
        update.GetProperty("nextCheckAt").ValueKind.Should().Be(JsonValueKind.String);
    }

    [Fact]
    public async Task List_FollowsTheUpdateMessagesTheAgentSendsWhileConnected()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithUpdateAsync(app, UpdateState("up_to_date", Installed), "transport.keepalive.v1", Maintenance);

        await agent.SendTextAsync(agent.Envelope("agent.update.status.v1", UpdateState("updating", Newer)));
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Update?.Outcome == "updating", "estado novo");
        (await ListedAsync(app)).GetProperty("update").GetProperty("state").GetString().Should().Be("updating");

        await agent.SendTextAsync(agent.Envelope(
            "agent.update.status.v1", UpdateState("failed", Newer, reason: "não consegui baixar o pacote (ConnectError)")));
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Update?.Outcome == "failed", "falha");
        var failed = (await ListedAsync(app)).GetProperty("update");
        failed.GetProperty("state").GetString().Should().Be("failed");
        failed.GetProperty("reason").GetString().Should().Be("não consegui baixar o pacote (ConnectError)");
        failed.GetProperty("latestSha").GetString().Should().Be(Newer);
    }

    [Fact]
    public async Task List_AnAgentThatNeverToldItsUpdateStateHasNone_SoTheScreenSaysUnknownVersion()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Logs, Maintenance);

        var item = await ListedAsync(app);

        item.GetProperty("update").ValueKind.Should().Be(JsonValueKind.Null);
        item.GetProperty("canRollback").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task UpdateMessage_OutsideTheContract_IsRefusedAndChangesNothing()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithUpdateAsync(app, UpdateState("up_to_date", Installed), "transport.keepalive.v1", Maintenance);

        await agent.SendTextAsync(agent.Envelope("agent.update.status.v1", new JsonObject { ["outcome"] = "exploded" }));
        await agent.SendTextAsync(agent.Envelope(
            "agent.update.status.v1", new JsonObject { ["outcome"] = "failed", ["reason"] = new string('x', 201) }));
        await TransportApp.WaitUntilAsync(
            () => app.App.Logs.Lines.Count(l => l.Contains("agent.update.status.v1", StringComparison.Ordinal)) >= 2, "recusas registradas");

        app.Presence.Get(app.Agent.Slug)!.Update!.Outcome.Should().Be("up_to_date");
    }

    [Fact]
    public async Task UpdateState_NeverLeavesInPresenceEvents()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithUpdateAsync(app, UpdateState("failed", Newer, Previous, "segredo-de-teste"), Maintenance);

        JsonSerializer.Serialize(app.Presence.All()).Should().NotContain(Installed).And.NotContain("segredo-de-teste");
    }

    [Fact]
    public async Task Rollback_NeedsTheStepUp_AndAPreviousVersionTheAgentReported()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithUpdateAsync(app, UpdateState("updated", Installed), "transport.keepalive.v1", Maintenance);

        using var withoutStepUp = await app.App.SendAsync(
            HttpMethod.Post, MaintenanceUrl(app), new { action = "rollback" }, app.Login.AccessToken);
        withoutStepUp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await DevicesApp.JsonAsync(withoutStepUp)).GetProperty("type").GetString().Should().EndWith("/step-up-required");

        var (devices, authenticator) = await WithPasskeyAsync(app);
        using var _ = authenticator;
        await devices.ConfirmStepUpAsync(app.Login, authenticator, StepUpAction);
        using var noPrevious = await app.App.SendAsync(
            HttpMethod.Post, MaintenanceUrl(app), new { action = "rollback" }, app.Login.AccessToken);

        noPrevious.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(noPrevious)).GetProperty("type").GetString().Should().EndWith("/no-previous-version");
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "agent_rollback_requested", Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Rollback_AfterThePasskey_TellsTheAgentToGoBack_AndAudits()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithUpdateAsync(app, UpdateState("updated", Installed, Previous), "transport.keepalive.v1", Maintenance);
        (await ListedAsync(app)).GetProperty("canRollback").GetBoolean().Should().BeTrue();
        var (devices, authenticator) = await WithPasskeyAsync(app);
        using var _ = authenticator;
        await devices.ConfirmStepUpAsync(app.Login, authenticator, StepUpAction);

        var http = app.App.SendAsync(HttpMethod.Post, MaintenanceUrl(app), new { action = "rollback" }, app.Login.AccessToken);
        var command = (await agent.ReceiveAsync())!.Value;
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Ok(), command.GetProperty("id").GetGuid()));
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await DevicesApp.JsonAsync(response)).GetProperty("action").GetString().Should().Be("rollback");
        command.GetProperty("body").GetProperty("action").GetString().Should().Be("rollback");
        await using var db = app.App.Db();
        var audit = await db.PairingAudit.SingleAsync(a => a.Event == "agent_rollback_requested", Ct);
        audit.AgentId.Should().Be(app.Agent.Id);
        audit.UserId.Should().NotBeNull();
    }

    [Fact]
    public async Task Rollback_AGuestGets403_AndWhenTheAgentRefusesNothingIsAudited()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithUpdateAsync(app, UpdateState("updated", Installed, Previous), "transport.keepalive.v1", Maintenance);
        var guest = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow());
        using var asGuest = await app.App.SendAsync(
            HttpMethod.Post, MaintenanceUrl(app), new { action = "rollback" }, guest.Login.AccessToken);
        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var (devices, authenticator) = await WithPasskeyAsync(app);
        using var _ = authenticator;
        await devices.ConfirmStepUpAsync(app.Login, authenticator, StepUpAction);
        var http = app.App.SendAsync(HttpMethod.Post, MaintenanceUrl(app), new { action = "rollback" }, app.Login.AccessToken);
        var command = (await agent.ReceiveAsync())!.Value;
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Failed("no_previous_version"), command.GetProperty("id").GetGuid()));
        using var refused = await Within(http);

        refused.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await DevicesApp.JsonAsync(refused)).GetProperty("agentError").GetString().Should().Be("no_previous_version");
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "agent_rollback_requested", Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Presence_EventsNeverCarryTheComputerDetails()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, Logs);

        var json = JsonSerializer.Serialize(app.Presence.All());

        json.Should().NotContain("192.168.0.20").And.NotContain("Windows 11");
    }
}
