using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// Refazer o registro do ADB para o aparelho de agora ("é a mesma TV"): só para agente que declara <c>tv.adb.rebind.v1</c>,
/// com corpo vazio, na permissão de quem abre apps e com linha na trilha.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class AdbRebindTests(PostgresFixture postgres)
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

    [Fact]
    public async Task Rebind_IsSentToAnAgentThatDeclaresIt_WithAnEmptyBody_AndLeavesAnAuditRow()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote", "tv.adb.rebind.v1");

        var request = app.PostAsync("/api/v1/tv/adb/rebind", new { });
        var command = await TvApp.NextCommandAsync(agent);

        command.GetProperty("type").GetString().Should().Be("tv.adb.rebind.v1");
        command.GetProperty("body").GetRawText().Should().Be("{}");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.adb.rebind");
        row.Ok.Should().BeTrue();
    }

    [Fact]
    public async Task Rebind_ToAnAgentWithoutTheCapability_Returns409_AndNothingGoesToIt()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote");

        using var response = await Within(app.PostAsync("/api/v1/tv/adb/rebind", new { }));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/adb-rebind-unsupported");
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Rebind_WhenTheAgentFails_Returns502_AndTheAuditKeepsTheErrorCode()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote", "tv.adb.rebind.v1");

        var request = app.PostAsync("/api/v1/tv/adb/rebind", new { });
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed("adb_identity"));

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Ok.Should().BeFalse();
        row.ErrorCode.Should().Be("adb_identity");
    }

    [Fact]
    public async Task Rebind_WithTheAgentOffline_Returns503()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();

        using var response = await app.PostAsync("/api/v1/tv/adb/rebind", new { });

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-offline");
    }
}
