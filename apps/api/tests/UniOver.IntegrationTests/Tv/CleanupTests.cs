using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// A limpeza da TV de ponta a ponta: a rota, a mensagem ao agente (com o <c>requestId</c>), o relatório que o agente
/// manda antes do resultado, a auditoria e o tempo próprio de espera.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class CleanupTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    private static JsonObject ReportBody(
        JsonElement command, int closed = 6, int? before = 214, int? after = 596, int? freed = 382, string[]? failed = null) =>
        new()
        {
            ["requestId"] = command.GetProperty("body").GetProperty("requestId").GetString(),
            ["closedApps"] = closed,
            ["memoryBeforeMb"] = before,
            ["memoryAfterMb"] = after,
            ["freedMb"] = freed,
            ["failedSteps"] = new JsonArray([.. (failed ?? []).Select(s => (JsonNode)JsonValue.Create(s)!)]),
            ["at"] = "2026-10-20T12:00:00Z",
        };

    /// <summary>O que o agente de verdade faz: o relatório primeiro, o resultado do comando depois.</summary>
    private static async Task ReportThenReplyAsync(FakeAgent agent, JsonElement command, JsonObject? report = null, JsonObject? result = null)
    {
        await agent.SendTextAsync(agent.Envelope("tv.cleanup.result.v1", report ?? ReportBody(command), command.GetProperty("id").GetGuid()));
        await TvApp.ReplyAsync(agent, command, result);
    }

    [Fact]
    public async Task Cleanup_SendsTheMessageWithARequestId_AndAnswersWithTheReport()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/cleanup");
        var command = await TvApp.NextCommandAsync(agent);

        command.GetProperty("type").GetString().Should().Be("tv.cleanup.v1");
        command.GetProperty("source").GetString().Should().Be("api");
        command.GetProperty("target").GetString().Should().Be($"agent:{TvApp.AgentSlug}");
        Guid.TryParse(command.GetProperty("body").GetProperty("requestId").GetString(), out _).Should().BeTrue();
        command.GetProperty("body").EnumerateObject().Should().ContainSingle("o corpo só leva o requestId");

        await ReportThenReplyAsync(agent, command, ReportBody(command, failed: ["force-stop:com.exemplo.player"]));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await TvApp.JsonAsync(response);
        body.GetProperty("ok").GetBoolean().Should().BeTrue();
        body.GetProperty("latencyMs").GetInt32().Should().BeGreaterThanOrEqualTo(0);
        body.GetProperty("closedApps").GetInt32().Should().Be(6);
        body.GetProperty("freedMb").GetInt32().Should().Be(382);
        body.GetProperty("memoryBeforeMb").GetInt32().Should().Be(214);
        body.GetProperty("memoryAfterMb").GetInt32().Should().Be(596);
        body.GetProperty("failedSteps").EnumerateArray().Select(s => s.GetString()).Should().Equal("force-stop:com.exemplo.player");
    }

    [Fact]
    public async Task Cleanup_WhenTheMemoryCouldNotBeRead_AnswersNullInsteadOfInventingIt()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/cleanup");
        var command = await TvApp.NextCommandAsync(agent);
        await ReportThenReplyAsync(agent, command, ReportBody(command, closed: 2, before: null, after: null, freed: null));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await TvApp.JsonAsync(response);
        body.GetProperty("closedApps").GetInt32().Should().Be(2);
        body.GetProperty("freedMb").ValueKind.Should().Be(JsonValueKind.Null);
        body.GetProperty("memoryBeforeMb").ValueKind.Should().Be(JsonValueKind.Null);
        body.GetProperty("memoryAfterMb").ValueKind.Should().Be(JsonValueKind.Null);
        body.GetProperty("failedSteps").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task Cleanup_IsAuditedWithItsOwnName_AndNoDetail()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/cleanup");
        await ReportThenReplyAsync(agent, await TvApp.NextCommandAsync(agent));
        (await Within(request)).Dispose();

        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.cleanup");
        row.AgentId.Should().Be(TvApp.AgentSlug);
        row.Detail.Should().BeNull();
        row.Ok.Should().BeTrue();
        row.ErrorCode.Should().BeNull();
        row.Ip.Should().Be(TvApp.ClientIp);
        using var recent = await app.GetAsync("/api/v1/tv/commands/recent");
        (await TvApp.JsonAsync(recent))[0].GetProperty("command").GetString().Should().Be("tv.cleanup");
    }

    [Fact]
    public async Task Cleanup_WaitsLongerThanTheOtherCommands_BeforeGivingUp()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/cleanup");
        var command = await TvApp.NextCommandAsync(agent);

        // Os outros comandos desistem aos 8 s; a limpeza tem 30 s (o agente leva até ~25 s).
        app.Time.Advance(TimeSpan.FromSeconds(12));
        await Task.Delay(300, Ct);
        request.IsCompleted.Should().BeFalse("a espera própria da limpeza é maior que a dos outros comandos");

        await ReportThenReplyAsync(agent, command);
        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Cleanup_WithoutAReplyWithinItsOwnTimeout_Returns504_AndIsAudited()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/cleanup");
        _ = await TvApp.NextCommandAsync(agent);
        using var response = await app.AdvanceWhilePendingAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.GatewayTimeout);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-timeout");
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.cleanup");
        row.ErrorCode.Should().Be("agent_timeout");
    }

    [Fact]
    public async Task Cleanup_WithTheAgentOffline_Returns503_AndIsAudited()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();

        using var response = await app.PostAsync("/api/v1/tv/cleanup");

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-offline");
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).ErrorCode.Should().Be("agent_offline");
    }

    [Fact]
    public async Task Cleanup_WithNoAgentConfigured_Returns503()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { AgentId = string.Empty });

        using var response = await app.PostAsync("/api/v1/tv/cleanup");

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-not-configured");
    }

    [Fact]
    public async Task Cleanup_RefusedByTheAgentBecauseTheAdbIsDown_Returns502_WithTheStableCode_AndNoReport()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/cleanup");
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed("adb_unreachable"));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var problem = await TvApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/command-failed");
        problem.GetProperty("agentError").GetString().Should().Be("adb_unreachable");
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).ErrorCode.Should().Be("adb_unreachable");
    }

    [Fact]
    public async Task Cleanup_WhenTheAgentReportsAnotherCleanupRunning_Returns409()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/cleanup");
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed("cleanup_in_progress"));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/cleanup-in-progress");
    }

    [Fact]
    public async Task Cleanup_WhileAnotherIsRunning_Returns409_AndTheAgentReceivesOnlyTheFirst()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var first = app.PostAsync("/api/v1/tv/cleanup");
        var command = await TvApp.NextCommandAsync(agent);

        using var second = await Within(app.PostAsync("/api/v1/tv/cleanup"));
        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await TvApp.JsonAsync(second)).GetProperty("type").GetString().Should().EndWith("/cleanup-in-progress");

        await ReportThenReplyAsync(agent, command);
        using var firstResponse = await Within(first);
        firstResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(1, "o pedido recusado não chegou ao agente");

        // Terminada a primeira, a vez volta.
        var third = app.PostAsync("/api/v1/tv/cleanup");
        await ReportThenReplyAsync(agent, await TvApp.NextCommandAsync(agent));
        using var thirdResponse = await Within(third);
        thirdResponse.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Cleanup_ThatFailedFreesTheTurnForTheNext()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var first = app.PostAsync("/api/v1/tv/cleanup");
        await TvApp.ReplyAsync(agent, await TvApp.NextCommandAsync(agent), TvApp.Failed("adb_timeout"));
        using var failed = await Within(first);
        failed.StatusCode.Should().Be(HttpStatusCode.BadGateway);

        var second = app.PostAsync("/api/v1/tv/cleanup");
        await ReportThenReplyAsync(agent, await TvApp.NextCommandAsync(agent));
        using var ok = await Within(second);
        ok.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Cleanup_WhenTheCommandSucceedsButNoReportArrives_Returns502_InsteadOfInventingNumbers()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/cleanup");
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command);
        using var response = await app.AdvanceWhilePendingAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await TvApp.JsonAsync(response)).GetProperty("agentError").GetString().Should().Be("cleanup_report_missing");
    }

    [Fact]
    public async Task Cleanup_IgnoresAReportForAnotherRequestId()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/cleanup");
        var command = await TvApp.NextCommandAsync(agent);
        var wrong = ReportBody(command);
        wrong["requestId"] = Guid.NewGuid().ToString();
        await ReportThenReplyAsync(agent, command, wrong);
        using var response = await app.AdvanceWhilePendingAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
    }

    [Fact]
    public async Task Cleanup_IgnoresTheReportOfAnotherPairedAgent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var other = await app.PairAsync("PC Trabalho");
        await using var intruder = await app.ConnectAsync(other);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(other.Slug)?.Connected == true, "outro conectado");

        var request = app.PostAsync("/api/v1/tv/cleanup");
        var command = await TvApp.NextCommandAsync(agent);
        // O intruso conhece o requestId (de dentro do teste), mas só vale o agente que controla a TV.
        await intruder.SendTextAsync(intruder.Envelope("tv.cleanup.result.v1", ReportBody(command, closed: 99), command.GetProperty("id").GetGuid()));
        await TvApp.WaitUntilAsync(() => app.Presence.Get(other.Slug)?.LastMessageAt is not null, "mensagem do outro lida");
        await TvApp.ReplyAsync(agent, command);
        using var response = await app.AdvanceWhilePendingAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway, "o relatório do intruso não conta");
    }

    [Fact]
    public async Task Cleanup_Anonymous_Returns401()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var response = await app.PostAsync("/api/v1/tv/cleanup", bearer: null);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Cleanup_PastTheCommandsLimit_Returns429WithRetryAfter()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { CommandsPermitted = 2 });
        app.PassReconnectGrace();

        for (var i = 0; i < 2; i++)
        {
            using var allowed = await app.PostAsync("/api/v1/tv/cleanup");
            allowed.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, "o agente está fora, mas o limite ainda não estourou");
        }

        using var limited = await app.PostAsync("/api/v1/tv/cleanup");

        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        limited.Headers.RetryAfter.Should().NotBeNull();
    }

    [Fact]
    public async Task Cleanup_TheGuestMayUseItLikeTheOtherTvCommands_AndTheAuditKeepsWho()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        var request = app.SendAsync(HttpMethod.Post, "/api/v1/tv/cleanup", bearer: guest.Login.AccessToken);
        await ReportThenReplyAsync(agent, await TvApp.NextCommandAsync(agent));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).UserId.Should().Be(guest.UserId);
    }
}
