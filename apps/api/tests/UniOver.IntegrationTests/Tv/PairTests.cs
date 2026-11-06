using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// "Parear de novo" da Android TV: só o dono, só por pedido dele, em dois passos (mostrar o código; entregar o digitado).
/// O código é segredo de vida curta e nunca vai para a trilha de auditoria.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class PairTests(PostgresFixture postgres)
{
    private const string Code = "A1B2C3";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    private static async Task<FakeAgent> ConnectedAsync(TvApp app, bool knowsPairing = true)
    {
        var agent = await app.ConnectAsync();
        if (knowsPairing)
        {
            await agent.SendHelloAsync("2.0.0", "tv.remote", "tv.kind.android", "tv.pair.v1");
        }
        else
        {
            await agent.SendHelloAsync("2.0.0", "tv.remote", "tv.kind.android");
        }

        await TvApp.WaitUntilAsync(
            () => app.Presence.Get(TvApp.AgentSlug)?.Capabilities.Contains("tv.kind.android", StringComparer.Ordinal) == true,
            "capacidades do agente");
        return agent;
    }

    private static async Task ExpectNothingReachedTheAgentAsync(TvApp app, FakeAgent agent)
    {
        // Se o pedido tivesse chegado ao agente, ele seria o próximo comando, e não o da sondagem.
        var probe = app.PostAsync("/api/v1/tv/wake");
        var next = await TvApp.NextCommandAsync(agent);
        next.GetProperty("type").GetString().Should().Be("tv.wake.v1");
        await TvApp.ReplyAsync(agent, next);
        (await Within(probe)).Dispose();
    }

    [Fact]
    public async Task FirstStep_AsksTheAgentToShowTheCode_WithAnEmptyBody()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectedAsync(app);

        var request = app.PostAsync("/api/v1/tv/pair", new { });
        var command = await TvApp.NextCommandAsync(agent);

        command.GetProperty("type").GetString().Should().Be("tv.pair.v1");
        command.GetProperty("target").GetString().Should().Be($"agent:{TvApp.AgentSlug}");
        command.GetProperty("body").GetRawText().Should().Be("{}");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("ok").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task SecondStep_DeliversTheTypedCode_AndTheCodeNeverReachesTheAuditTrail()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectedAsync(app);

        var request = app.PostAsync("/api/v1/tv/pair", new { code = Code });
        var command = await TvApp.NextCommandAsync(agent);

        command.GetProperty("type").GetString().Should().Be("tv.pair.v1");
        command.GetProperty("body").GetProperty("code").GetString().Should().Be(Code);
        await TvApp.ReplyAsync(agent, command);
        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await response.Content.ReadAsStringAsync(Ct)).Should().NotContain(Code);

        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.CommandAudit.AnyAsync(Ct);
        }, "linha da auditoria");
        await using var audit = app.Db();
        var rows = await audit.CommandAudit.AsNoTracking().ToListAsync(Ct);
        var row = rows.Should().ContainSingle().Which;
        row.Command.Should().Be("tv.pair");
        row.Detail.Should().Be("step=finish");
        row.Ok.Should().BeTrue();
        System.Text.Json.JsonSerializer.Serialize(rows.Select(r => new { r.Command, r.Detail, r.ErrorCode, r.AgentId }))
            .Should().NotContain(Code);
    }

    [Fact]
    public async Task Cancel_TellsTheAgentToDropThePairing_AndIsAuditedWithAFixedDetail()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectedAsync(app);

        var request = app.PostAsync("/api/v1/tv/pair", new { cancel = true });
        var command = await TvApp.NextCommandAsync(agent);

        command.GetProperty("type").GetString().Should().Be("tv.pair.v1");
        command.GetProperty("body").GetRawText().Should().Be("{\"cancel\":true}");
        await TvApp.ReplyAsync(agent, command);
        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.CommandAudit.AnyAsync(Ct);
        }, "linha da auditoria");
        await using var audit = app.Db();
        (await audit.CommandAudit.AsNoTracking().SingleAsync(Ct)).Detail.Should().Be("step=cancel");
    }

    [Fact]
    public async Task CancelTogetherWithACode_IsRefusedBeforeReachingTheAgent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectedAsync(app);

        using var response = await Within(app.PostAsync("/api/v1/tv/pair", new { code = Code, cancel = true }));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await ExpectNothingReachedTheAgentAsync(app, agent);
    }

    [Fact]
    public async Task AskingForTheCodeAgainWithinTenSeconds_IsRefused_ButCancelAndFinishAreNotThrottled()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectedAsync(app);

        var first = app.PostAsync("/api/v1/tv/pair", new { });
        await TvApp.ReplyAsync(agent, await TvApp.NextCommandAsync(agent));
        (await Within(first)).StatusCode.Should().Be(HttpStatusCode.OK);

        using var tooSoon = await Within(app.PostAsync("/api/v1/tv/pair", new { }));
        tooSoon.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        tooSoon.Headers.RetryAfter.Should().NotBeNull();
        (await TvApp.JsonAsync(tooSoon)).GetProperty("type").GetString().Should().EndWith("pair-too-soon");
        await ExpectNothingReachedTheAgentAsync(app, agent);

        // Cancelar e entregar o código nunca esperam: só o pedido do código troca o código na TV.
        var cancel = app.PostAsync("/api/v1/tv/pair", new { cancel = true });
        var cancelCommand = await TvApp.NextCommandAsync(agent);
        cancelCommand.GetProperty("body").GetRawText().Should().Be("{\"cancel\":true}");
        await TvApp.ReplyAsync(agent, cancelCommand);
        (await Within(cancel)).StatusCode.Should().Be(HttpStatusCode.OK);

        // Passado o intervalo, o pedido do código volta a valer.
        app.Time.Advance(TimeSpan.FromSeconds(11));
        var again = app.PostAsync("/api/v1/tv/pair", new { });
        await TvApp.ReplyAsync(agent, await TvApp.NextCommandAsync(agent));
        (await Within(again)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("A1B2")]
    [InlineData("A1B2C3D")]
    [InlineData("ZZZZZZ")]
    [InlineData("A1 B2C")]
    [InlineData("")]
    public async Task ACodeOutsideTheTvFormat_IsRefusedBeforeReachingTheAgent(string code)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectedAsync(app);

        using var response = await Within(app.PostAsync("/api/v1/tv/pair", new { code }));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await ExpectNothingReachedTheAgentAsync(app, agent);
    }

    [Fact]
    public async Task ARefusedCode_ReportsTheStableAgentCode_WithoutEchoingTheCode()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectedAsync(app);

        var request = app.PostAsync("/api/v1/tv/pair", new { code = Code });
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed("invalid_code"));

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var problem = await TvApp.JsonAsync(response);
        problem.GetProperty("agentError").GetString().Should().Be("invalid_code");
        problem.GetRawText().Should().NotContain(Code);
    }

    [Fact]
    public async Task ToAnAgentWithoutTheCapability_IsRefusedWithAClearProblem_AndSendsNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectedAsync(app, knowsPairing: false);

        using var response = await Within(app.PostAsync("/api/v1/tv/pair", new { }));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("pair-unsupported");
        await ExpectNothingReachedTheAgentAsync(app, agent);
    }

    [Fact]
    public async Task OnlyTheOwnerCanPair_ADelegatedAccountWithControlCannot()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectedAsync(app);
        var guest = await app.NewGuestAsync("Convidado", ["module:tv", "tv:control", "tv:power", "tv:launch"], 95);

        using var anonymous = await app.PostAsync("/api/v1/tv/pair", new { }, bearer: null);
        using var forbidden = await app.PostAsync("/api/v1/tv/pair", new { }, bearer: guest.Login.AccessToken);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        forbidden.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await ExpectNothingReachedTheAgentAsync(app, agent);
    }

    [Fact]
    public async Task WithTheAgentOffline_AnswersAgentOffline()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();

        using var response = await Within(app.PostAsync("/api/v1/tv/pair", new { }));

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-offline");
    }
}
