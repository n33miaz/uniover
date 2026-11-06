using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// O sinal de presença: a tela da TV visível avisa o agente, que só então pode abrir uma conexão ADB nova. O tipo do
/// comando não prova ninguém (o atalho do iPhone manda teclas sem pessoa na tela), então tecla e Siri nunca o geram.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class PresenceTests(PostgresFixture postgres)
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
    public async Task Presence_IsRelayedToAnAgentThatDeclaresIt_WithoutReplyOrAudit()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote", "tv.presence.v1");

        using var response = await Within(app.PostAsync("/api/v1/tv/presence"));

        response.StatusCode.Should().Be(HttpStatusCode.Accepted);
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.presence.v1");
        command.GetProperty("body").EnumerateObject().Should().BeEmpty();
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Presence_IsLimitedToOneSignalEvery10SecondsPerAgent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote", "tv.presence.v1");

        for (var i = 0; i < 5; i++)
        {
            using var response = await Within(app.PostAsync("/api/v1/tv/presence"));
            response.StatusCode.Should().Be(HttpStatusCode.Accepted);
        }

        (await TvApp.NextCommandAsync(agent)).GetProperty("type").GetString().Should().Be("tv.presence.v1");
        var wake = app.PostAsync("/api/v1/tv/wake");
        var next = await TvApp.NextCommandAsync(agent);
        next.GetProperty("type").GetString().Should().Be("tv.wake.v1", "os outros quatro sinais não chegaram ao agente");
        await TvApp.ReplyAsync(agent, next);
        (await Within(wake)).Dispose();
    }

    [Fact]
    public async Task Presence_ToAnAgentWithoutTheCapability_IsAcceptedAndSendsNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote");

        using var response = await Within(app.PostAsync("/api/v1/tv/presence"));

        response.StatusCode.Should().Be(HttpStatusCode.Accepted);
        var wake = app.PostAsync("/api/v1/tv/wake");
        var next = await TvApp.NextCommandAsync(agent);
        next.GetProperty("type").GetString().Should().Be("tv.wake.v1", "o agente antigo não conhece o sinal");
        await TvApp.ReplyAsync(agent, next);
        (await Within(wake)).Dispose();
    }

    [Fact]
    public async Task Presence_WithTheAgentOffline_IsStillAcceptedQuietly()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();

        using var response = await app.PostAsync("/api/v1/tv/presence");

        response.StatusCode.Should().Be(HttpStatusCode.Accepted);
    }

    [Fact]
    public async Task Presence_WithoutCredentials_Returns401()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var response = await app.PostAsync("/api/v1/tv/presence", bearer: null);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task AKeyCommand_NeverCountsAsPresence()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await AnnounceAsync(app, agent, "tv.remote", "tv.presence.v1");

        var key = app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.key.v2");
        await TvApp.ReplyAsync(agent, command);
        (await Within(key)).Dispose();

        // O atalho do iPhone e o desligamento agendado também só mandam o comando: nenhum sinal de presença sobe sozinho.
        var wake = app.PostAsync("/api/v1/tv/wake");
        var next = await TvApp.NextCommandAsync(agent);
        next.GetProperty("type").GetString().Should().Be("tv.wake.v1");
        await TvApp.ReplyAsync(agent, next);
        (await Within(wake)).Dispose();
    }
}
