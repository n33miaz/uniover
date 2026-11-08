using System.Net;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// Abrir na TV a tela de rede ou as configurações: lista fechada de duas telas, só para agente que declara
/// <c>tv.settings.open.v1</c>, na permissão do controle e com linha na trilha.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class OpenSettingsTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    private static async Task AnnounceAsync(TvApp app, FakeAgent agent, params string[] capabilities)
    {
        await agent.SendHelloAsync("2.0.0", capabilities);
        await TvApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains(capabilities[^1], StringComparer.Ordinal) == true,
            "capacidades do agente");
    }

    [Theory]
    [InlineData("WIFI")]
    [InlineData("SETTINGS")]
    public async Task OpenSettings_IsSentToAnAgentThatDeclaresIt_AndLeavesAnAuditRowWithTheScreen(string screen)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote", "tv.settings.open.v1");

        var request = app.PostAsync("/api/v1/tv/settings/open", new { screen });
        var command = await TvApp.NextCommandAsync(agent);

        command.GetProperty("type").GetString().Should().Be("tv.settings.open.v1");
        command.GetProperty("body").GetRawText().Should().Be($"{{\"screen\":\"{screen}\"}}");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("ok").GetBoolean().Should().BeTrue();
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.settings.open");
        row.Detail.Should().Be(screen);
        row.Ok.Should().BeTrue();
    }

    [Theory]
    [InlineData("""{"screen":"DEVELOPER"}""")]
    [InlineData("""{"screen":"wifi"}""")]
    [InlineData("""{"screen":"android.settings.WIFI_SETTINGS"}""")]
    [InlineData("""{"screen":" WIFI "}""")]
    [InlineData("""{"screen":""}""")]
    [InlineData("""{"action":"android.settings.SETTINGS"}""")]
    [InlineData("""{}""")]
    public async Task OpenSettings_WithAScreenOutsideTheClosedList_Returns400_AndNothingGoesToTheAgent(string json)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote", "tv.settings.open.v1");

        using var response = await Within(app.PostAsync("/api/v1/tv/settings/open", JsonNode.Parse(json)));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        response.Content.Headers.ContentType!.MediaType.Should().Be("application/problem+json");
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0, "o que nunca chegou ao agente não é comando");
    }

    [Fact]
    public async Task OpenSettings_ToAnAgentWithoutTheCapability_Returns409_AndSendsNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote", "tv.kind.samsung");

        using var response = await Within(app.PostAsync("/api/v1/tv/settings/open", new { screen = "WIFI" }));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/settings-unsupported");
        var wake = app.PostAsync("/api/v1/tv/wake");
        var next = await TvApp.NextCommandAsync(agent);
        next.GetProperty("type").GetString().Should().Be("tv.wake.v1", "a TV sem a capacidade não recebeu a abertura");
        await TvApp.ReplyAsync(agent, next);
        (await Within(wake)).Dispose();
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task OpenSettings_WhenTheAgentFails_Returns502_AndTheAuditKeepsTheErrorCode()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote", "tv.settings.open.v1");

        var request = app.PostAsync("/api/v1/tv/settings/open", new { screen = "SETTINGS" });
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed("failed"));

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Ok.Should().BeFalse();
        row.ErrorCode.Should().Be("failed");
    }

    [Fact]
    public async Task OpenSettings_WithTheAgentOffline_Returns503()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();

        using var response = await app.PostAsync("/api/v1/tv/settings/open", new { screen = "WIFI" });

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-offline");
    }
}
