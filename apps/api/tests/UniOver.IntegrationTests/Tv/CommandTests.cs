using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class CommandTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    [Fact]
    public async Task Key_IsSentToTheAgentAsV2WithTheCorrelationId_AndAnswersWith200()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/keys", new { key = "VOLUME_UP" });
        var command = await TvApp.NextCommandAsync(agent);

        command.GetProperty("type").GetString().Should().Be("tv.key.v2");
        command.GetProperty("source").GetString().Should().Be("api");
        command.GetProperty("target").GetString().Should().Be($"agent:{TvApp.AgentSlug}");
        command.GetProperty("body").GetRawText().Should().Be("{\"key\":\"VOLUME_UP\"}");

        await TvApp.ReplyAsync(agent, command);
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await TvApp.JsonAsync(response);
        body.GetProperty("ok").GetBoolean().Should().BeTrue();
        body.GetProperty("latencyMs").GetInt32().Should().BeGreaterThanOrEqualTo(0);
    }

    [Fact]
    public async Task Key_OutsideTheV2List_IsSentAsV3()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/keys", new { key = "GUIDE" });
        var command = await TvApp.NextCommandAsync(agent);

        command.GetProperty("type").GetString().Should().Be("tv.key.v3");
        command.GetProperty("body").GetRawText().Should().Be("{\"key\":\"GUIDE\"}");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Key_WithANameOutsideTheContract_IsRefusedBeforeReachingTheAgent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        using var response = await Within(app.PostAsync("/api/v1/tv/keys", new { key = "FACTORY_RESET" }));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Key_WithALongPressDirection_CarriesIt()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/keys", new { key = "DOWN", direction = "START_LONG" });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("body").GetProperty("direction").GetString().Should().Be("START_LONG");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("""{"key":"NOT_A_KEY"}""")]
    [InlineData("""{"key":"volume_up"}""")]
    [InlineData("""{"key":"POWER"}""")]
    [InlineData("""{"key":"UP","direction":"SIDEWAYS"}""")]
    [InlineData("""{}""")]
    public async Task Key_WithAnInvalidBody_Returns400_AndNothingGoesToTheAgent(string json)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        using var response = await app.PostAsync("/api/v1/tv/keys", JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        response.Content.Headers.ContentType!.MediaType.Should().Be("application/problem+json");
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0, "o que nunca chegou ao agente não é comando");
    }

    [Fact]
    public async Task Key_WithoutABody_Returns400()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var response = await app.PostAsync("/api/v1/tv/keys");

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Command_WithTheAgentOffline_Returns503_AndIsAudited()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();

        using var response = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        var problem = await TvApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/agent-offline");

        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Ok.Should().BeFalse();
        row.ErrorCode.Should().Be("agent_offline");
        row.Command.Should().Be("tv.key");
    }

    [Fact]
    public async Task Command_SentWhileTheAgentIsReconnecting_WaitsForTheSession_AndIsDelivered()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var dropped = await app.ConnectAndWaitAsync();
        await dropped.DisposeAsync();
        await TvApp.WaitUntilAsync(() => app.Presence.Get(TvApp.AgentSlug)?.Connected == false, "agente caiu");
        app.Time.Advance(TimeSpan.FromSeconds(1));

        // O toque cai dentro da janela: a presença já diz desconectado, mas o comando espera o agente voltar.
        var request = app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
        await Task.Delay(200, Ct);
        request.IsCompleted.Should().BeFalse("dentro da janela de reconexão o comando espera, não falha");

        await using var back = await app.ConnectAsync();
        var command = await TvApp.NextCommandAsync(back);
        command.GetProperty("type").GetString().Should().Be("tv.key.v2");
        await TvApp.ReplyAsync(back, command);
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Ok.Should().BeTrue();
        row.ErrorCode.Should().BeNull();
    }

    [Fact]
    public async Task Command_AfterTheAgentStayedGonePastTheReconnectWindow_FailsAtOnce()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var dropped = await app.ConnectAndWaitAsync();
        await dropped.DisposeAsync();
        await TvApp.WaitUntilAsync(() => app.Presence.Get(TvApp.AgentSlug)?.Connected == false, "agente caiu");
        app.PassReconnectGrace();

        using var response = await Within(app.PostAsync("/api/v1/tv/keys", new { key = "HOME" }));

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-offline");
    }

    [Fact]
    public async Task Command_WithoutAReply_Returns504_AndIsAudited()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
        _ = await TvApp.NextCommandAsync(agent);

        using var response = await app.AdvanceWhilePendingAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.GatewayTimeout);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-timeout");
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).ErrorCode.Should().Be("agent_timeout");
    }

    [Fact]
    public async Task Command_RefusedByTheAgent_Returns502_WithTheAgentErrorCode()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed("TV_UNREACHABLE"));

        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var problem = await TvApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/command-failed");
        problem.GetProperty("agentError").GetString().Should().Be("TV_UNREACHABLE");
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Ok.Should().BeFalse();
        row.ErrorCode.Should().Be("TV_UNREACHABLE");
    }

    [Fact]
    public async Task Command_WithNoAgentConfigured_Returns503_AndTheApiStillBoots()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { WithoutTv = true });

        using var response = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-not-configured");
        using var state = await app.GetAsync("/api/v1/tv/state");
        state.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Audit_RecordsWhoFromWhereWhichAgentAndTheResult()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/keys", new { key = "NUM_5", direction = "SHORT" });
        await TvApp.ReplyAsync(agent, await TvApp.NextCommandAsync(agent));
        (await Within(request)).Dispose();

        var userId = await UserIdAsync(app);
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.UserId.Should().Be(userId);
        row.AgentId.Should().Be(TvApp.AgentSlug);
        row.Command.Should().Be("tv.key");
        row.Detail.Should().Be("NUM_5/SHORT");
        row.Ok.Should().BeTrue();
        row.ErrorCode.Should().BeNull();
        row.LatencyMs.Should().NotBeNull();
        row.Ip.Should().Be(TvApp.ClientIp);
        row.UserAgent.Should().Be(TvApp.UserAgentText);
        row.OccurredAt.Should().Be(app.Time.GetUtcNow());
    }

    [Fact]
    public async Task Text_IsSentToTheAgent_AndTheAuditKeepsOnlyItsLength()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        const string secret = "senha-super-secreta-123";

        var request = app.PostAsync("/api/v1/tv/text", new { text = secret });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.text.v1");
        command.GetProperty("body").GetProperty("text").GetString().Should().Be(secret);
        await TvApp.ReplyAsync(agent, command);
        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.text");
        row.Detail.Should().Be($"length={secret.Length}");

        // Nem na tabela inteira, nem no histórico curto, nem nos logs da API.
        var dump = JsonSerializer.Serialize(await db.CommandAudit.AsNoTracking().ToListAsync(Ct));
        dump.Should().NotContain(secret);
        using var recent = await app.GetAsync("/api/v1/tv/commands/recent");
        (await recent.Content.ReadAsStringAsync(Ct)).Should().NotContain(secret);
        app.Logs.Lines.Should().NotContain(l => l.Contains(secret, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Text_Empty_IsSentToTheAgent_ToClearWhatWasTyped()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = app.PostAsync("/api/v1/tv/text", new { text = string.Empty });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.text.v1");
        command.GetProperty("body").GetProperty("text").GetString().Should().BeEmpty();
        await TvApp.ReplyAsync(agent, command);
        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("""{"text":"linha\nnova"}""")]
    [InlineData("""{}""")]
    public async Task Text_Invalid_Returns400(string json)
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var response = await app.PostAsync("/api/v1/tv/text", JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Text_Above200Characters_Returns400()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var response = await app.PostAsync("/api/v1/tv/text", new { text = new string('a', 201) });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PowerOff_NeedsOnlyTheLogin_AndTheAgentReceivesPower()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        // Sem confirmação por passkey: o dono decidiu que desligar a TV não a exige.
        var request = app.PostAsync("/api/v1/tv/power/off");
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.key.v2");
        command.GetProperty("body").GetProperty("key").GetString().Should().Be("POWER");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.power-off");
        row.Ok.Should().BeTrue();
    }

    [Fact]
    public async Task PowerOff_Safe_ToAnAgentWithTheCapability_SendsTheSafeMessage_AndAnswersOff()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await DeclarePowerOffAsync(app, agent);

        var request = app.PostAsync("/api/v1/tv/power/off", new { mode = "safe" });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.power.off.v1");
        command.GetProperty("body").GetRawText().Should().Be("{}");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await TvApp.JsonAsync(response);
        body.GetProperty("ok").GetBoolean().Should().BeTrue();
        body.GetProperty("outcome").GetString().Should().Be("off");
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.power-off");
        row.Ok.Should().BeTrue();
    }

    [Fact]
    public async Task PowerOff_Safe_ToAnAgentWithoutTheCapability_StillSendsThePowerKey()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.kind.android");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(TvApp.AgentSlug)?.Capabilities.Contains("tv.remote") == true, "capacidades do agente");

        var request = app.PostAsync("/api/v1/tv/power/off", new { mode = "safe" });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.key.v2");
        command.GetProperty("body").GetProperty("key").GetString().Should().Be("POWER");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("outcome").GetString().Should().Be("sent");
    }

    [Fact]
    public async Task PowerOff_WithoutTheSafeMode_KeepsSendingThePowerKey_EvenToAnAgentWithTheCapability()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await DeclarePowerOffAsync(app, agent);

        var request = app.PostAsync("/api/v1/tv/power/off");
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.key.v2");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("outcome").GetString().Should().Be("sent");
    }

    [Fact]
    public async Task PowerOff_Safe_WhenTheAgentFoundTheTvAlreadyOff_AnswersAnOutcomeInsteadOfAnError()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await DeclarePowerOffAsync(app, agent);

        var request = app.PostAsync("/api/v1/tv/power/off", new { mode = "safe" });
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed("already_off"));

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("outcome").GetString().Should().Be("already_off");
    }

    [Theory]
    [InlineData("uncertain")]
    [InlineData("offline")]
    [InlineData("failed")]
    public async Task PowerOff_Safe_WhenTheAgentCouldNotTurnItOff_Answers502WithItsCode(string code)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await DeclarePowerOffAsync(app, agent);

        var request = app.PostAsync("/api/v1/tv/power/off", new { mode = "safe" });
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed(code));

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await TvApp.JsonAsync(response)).GetProperty("agentError").GetString().Should().Be(code);
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Ok.Should().BeFalse();
        row.ErrorCode.Should().Be(code);
    }

    [Fact]
    public async Task PowerOff_WithAModeOutsideTheContract_Returns400_AndNothingReachesTheAgent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await DeclarePowerOffAsync(app, agent);

        using var response = await Within(app.PostAsync("/api/v1/tv/power/off", new { mode = "force" }));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0);
    }

    private static async Task DeclarePowerOffAsync(TvApp app, FakeAgent agent)
    {
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.kind.android", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(
            () => app.Presence.Get(TvApp.AgentSlug)?.Capabilities.Contains("tv.power.off.v1") == true, "capacidades do agente");
    }

    [Fact]
    public async Task PowerOff_Anonymous_Returns401()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var response = await app.PostAsync("/api/v1/tv/power/off", bearer: null);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task OnlyTheComputerSwitch_AsksForAPasskeyConfirmation_NoTvCommandDoes()
    {
        await using var app = await TvApp.StartAsync(postgres);

        var tvRoutes = app.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(r => (r.RoutePattern.RawText ?? string.Empty).StartsWith("/api/v1/tv/", StringComparison.Ordinal))
            .ToList();

        tvRoutes.Should().NotBeEmpty();

        // Comandar a TV nunca pede a passkey; trocar o computador ou a filiação de uma TV é administração perigosa.
        var adminPatterns = TvPermissionMap.AdminRoutes.Select(r => r.Pattern).ToHashSet(StringComparer.Ordinal);
        tvRoutes.Where(r => !adminPatterns.Contains(r.RoutePattern.RawText!))
            .SelectMany(r => r.Metadata.GetOrderedMetadata<IAuthorizeData>())
            .Should().NotContain(a => a.Policy != null && a.Policy.StartsWith(StepUp.PolicyPrefix, StringComparison.Ordinal));
        tvRoutes.SelectMany(r => r.Metadata.GetOrderedMetadata<IAuthorizeData>())
            .Where(a => a.Policy != null && a.Policy.StartsWith(StepUp.PolicyPrefix, StringComparison.Ordinal))
            .Select(a => a.Policy)
            .Should().OnlyContain(policy => policy == StepUp.Policy(TvAuth.BindAgentAction));
        RouteInspector.Violations(tvRoutes).Should().BeEmpty();
    }

    [Fact]
    public async Task Wake_IsAccepted_WithoutWaitingForAReply_AndDoesNotCreateAuditWhileKeysDo()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        using var response = await Within(app.PostAsync("/api/v1/tv/wake"));

        response.StatusCode.Should().Be(HttpStatusCode.Accepted);
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.wake.v1");

        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0);

        var keyRequest = app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
        var key = await TvApp.NextCommandAsync(agent);
        key.GetProperty("type").GetString().Should().Be("tv.key.v2");
        await TvApp.ReplyAsync(agent, key);
        using var keyResponse = await Within(keyRequest);

        keyResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        (await db.CommandAudit.SingleAsync(Ct)).Command.Should().Be("tv.key");
    }

    [Fact]
    public async Task Wake_WithTheAgentOffline_Returns503()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();

        using var response = await app.PostAsync("/api/v1/tv/wake");

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task WakeAuditMigration_RemovesOnlyTechnicalPrewarmRows()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using var db = TvApp.CreateContext(database.OwnerConnection);
        await db.Database.MigrateAsync("20261031221403_AddTvFocusPackages", Ct);

        await db.Database.ExecuteSqlAsync(
            $"""
            INSERT INTO tv.command_audit (id, tv_id, user_id, command, ok, occurred_at)
            VALUES ({Guid.NewGuid()}, {Guid.NewGuid()}, {Guid.NewGuid()}, {"tv.wake"}, {true}, now()),
                   ({Guid.NewGuid()}, {Guid.NewGuid()}, {Guid.NewGuid()}, {"tv.key"}, {true}, now())
            """, Ct);

        await db.Database.MigrateAsync(Ct);

        var commands = await db.CommandAudit.AsNoTracking().Select(entry => entry.Command).ToListAsync(Ct);
        commands.Should().Equal("tv.key");
    }

    [Fact]
    public async Task EveryCommandRoute_WithoutLogin_Returns401()
    {
        await using var app = await TvApp.StartAsync(postgres);

        foreach (var (method, url) in new[]
        {
            (HttpMethod.Post, "/api/v1/tv/keys"), (HttpMethod.Post, "/api/v1/tv/text"), (HttpMethod.Post, "/api/v1/tv/power/off"),
            (HttpMethod.Post, "/api/v1/tv/wake"), (HttpMethod.Post, "/api/v1/tv/shortcuts/refresh"), (HttpMethod.Post, "/api/v1/tv/cleanup"),
            (HttpMethod.Post, $"/api/v1/tv/shortcuts/{Guid.NewGuid()}/launch"), (HttpMethod.Patch, $"/api/v1/tv/shortcuts/{Guid.NewGuid()}"),
            (HttpMethod.Get, "/api/v1/tv/state"), (HttpMethod.Get, "/api/v1/tv/shortcuts"), (HttpMethod.Get, "/api/v1/tv/commands/recent"),
        })
        {
            using var response = await app.SendAsync(method, url, bearer: null);
            response.StatusCode.Should().Be(HttpStatusCode.Unauthorized, $"{method} {url}");
        }
    }

    [Fact]
    public async Task Commands_PastTheConfiguredLimit_Return429WithRetryAfter()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { CommandsPermitted = 3 });
        app.PassReconnectGrace();

        for (var i = 0; i < 3; i++)
        {
            using var allowed = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
            allowed.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, "o agente está fora, mas o limite ainda não estourou");
        }

        using var limited = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });

        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        limited.Headers.RetryAfter.Should().NotBeNull();
    }

    [Fact]
    public async Task CommandsLimit_IsPerUser_SoTwoUsersDoNotShareABucket()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { CommandsPermitted = 3 });
        app.PassReconnectGrace();
        var other = app.OtherUserToken();

        for (var i = 0; i < 3; i++)
        {
            using var allowed = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
            allowed.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        }

        using var first = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
        first.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);

        // Mesmo IP, outro usuário: balde próprio, ainda com as três chamadas inteiras.
        for (var i = 0; i < 3; i++)
        {
            using var second = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" }, bearer: other);
            second.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, $"o usuário novo está na chamada {i + 1} de 3");
        }

        using var secondLimited = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" }, bearer: other);
        secondLimited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task RecentCommands_ListsTheLatestFirst_AndValidatesTheLimit()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();
        foreach (var key in new[] { "HOME", "BACK", "MENU" })
        {
            (await app.PostAsync("/api/v1/tv/keys", new { key })).Dispose();
            app.Time.Advance(TimeSpan.FromSeconds(1));
        }

        using var response = await app.GetAsync("/api/v1/tv/commands/recent?limit=2");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var items = await TvApp.JsonAsync(response);
        items.GetArrayLength().Should().Be(2);
        items[0].GetProperty("detail").GetString().Should().Be("MENU");
        items[1].GetProperty("detail").GetString().Should().Be("BACK");
        items[0].GetProperty("command").GetString().Should().Be("tv.key");
        items[0].TryGetProperty("ip", out _).Should().BeFalse();

        using var bad = await app.GetAsync("/api/v1/tv/commands/recent?limit=0");
        bad.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task CommandAudit_IsOnlyAppendedByTheApplication_AndTheRetentionIsTheDatabaseFunction()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();
        await app.ExecuteSqlAsync(
            "INSERT INTO tv.command_audit (id, tv_id, user_id, command, ok, occurred_at) " +
            "SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'tv.key', true, now() - interval '40 days' FROM generate_series(1, 20)");
        await app.ExecuteSqlAsync(
            "INSERT INTO tv.command_audit (id, tv_id, user_id, command, ok, occurred_at) " +
            "SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'tv.key', true, now() - (g * interval '1 second') - interval '1 hour' FROM generate_series(1, 5010) g");

        (await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" })).Dispose();

        // Gravar um comando não apaga nada: a aplicação não tem DELETE, e a trilha também não tem mais teto de linhas.
        await using (var db = app.Db())
        {
            (await db.CommandAudit.CountAsync(a => a.OccurredAt < DateTimeOffset.UtcNow.AddDays(-30), Ct)).Should().Be(20, "só a função de retenção apaga");
            (await db.CommandAudit.CountAsync(Ct)).Should().Be(20 + 5010 + 1);
            (await db.CommandAudit.CountAsync(a => a.Detail == "HOME", Ct)).Should().Be(1);
        }

        // A função (chamada pelo serviço de retenção, com o papel da aplicação) apaga só o que passou do prazo.
        var removed = await UniOver.IntegrationTests.Audit.AuditKit.ScalarAsync(app.Database.RuntimeConnection, "SELECT tv.purge_audit(30)");

        removed.Should().Be(20);
        await using var after = app.Db();
        (await after.CommandAudit.CountAsync(a => a.OccurredAt < DateTimeOffset.UtcNow.AddDays(-30), Ct)).Should().Be(0);
        (await after.CommandAudit.CountAsync(Ct)).Should().Be(5010 + 1, "o recente fica, sem teto de linhas");
    }

    private static async Task<Guid> UserIdAsync(TvApp app)
    {
        using var response = await app.GetAsync("/api/v1/identity/me");
        response.EnsureSuccessStatusCode();
        return (await TvApp.JsonAsync(response)).GetProperty("id").GetGuid();
    }
}
