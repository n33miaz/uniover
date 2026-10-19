using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class StreamTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Events_WithTheStreamCookie_SendASnapshotAndThenTheChanges()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.a.um", "Um"))));
        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.Shortcuts.AnyAsync(Ct);
        }, "atalho criado");

        var ticket = await app.StreamTicketAsync();
        using var response = await app.OpenEventsAsync(ticket);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.MediaType.Should().Be("text/event-stream");
        using var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));

        var state = (await reader.NextAsync())!;
        state.EventType.Should().Be("tv.state");
        state.Data!.Value.GetProperty("agentOnline").GetBoolean().Should().BeTrue();
        state.Data!.Value.GetProperty("power").GetString().Should().Be("unknown");

        var shortcuts = (await reader.NextAsync())!;
        shortcuts.EventType.Should().Be("tv.shortcuts");
        shortcuts.Data!.Value.GetArrayLength().Should().Be(1);
        shortcuts.Data!.Value[0].GetProperty("package").GetString().Should().Be("com.a.um");

        // Uma mudança de estado do agente chega ao fluxo, com o volume.
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(power: "on", volume: 21)));
        var change = (await reader.NextAsync())!;
        change.EventType.Should().Be("tv.state");
        change.Data!.Value.GetProperty("power").GetString().Should().Be("on");
        change.Data!.Value.GetProperty("volume").GetInt32().Should().Be(21);

        // Renomear um atalho empurra a lista nova.
        var id = shortcuts.Data!.Value[0].GetProperty("id").GetGuid();
        (await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{id}", new { customLabel = "Meu app" })).Dispose();
        var renamed = (await reader.NextAsync())!;
        renamed.EventType.Should().Be("tv.shortcuts");
        renamed.Data!.Value[0].GetProperty("customLabel").GetString().Should().Be("Meu app");

        // E um evento do vigia também.
        await agent.SendTextAsync(agent.Envelope("tv.watchdog.v1", new System.Text.Json.Nodes.JsonObject
        {
            ["kind"] = "port_closed", ["severity"] = "warn", ["detail"] = "porta fechada", ["attempts"] = 1, ["at"] = "2026-10-19T12:00:00Z",
        }));
        var watchdog = (await reader.NextAsync())!;
        watchdog.EventType.Should().Be("tv.watchdog");
        watchdog.Data!.Value.GetProperty("kind").GetString().Should().Be("port_closed");
    }

    [Fact]
    public async Task Events_WithoutTheCookie_Return401_AndNeverAcceptATokenInTheUrl()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var ticket = await app.StreamTicketAsync();

        using var anonymous = await app.OpenEventsAsync(cookieTicket: null);
        using var jwtInQuery = await app.OpenEventsAsync(cookieTicket: null, query: $"?access_token={app.Login.AccessToken}");
        using var ticketInQuery = await app.OpenEventsAsync(cookieTicket: null, query: $"?uo_st={ticket}");

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        jwtInQuery.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        ticketInQuery.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // O JWT de acesso no cabeçalho também não abre o stream: só o bilhete em cookie.
        using var bearer = await app.GetAsync("/api/v1/tv/events");
        bearer.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Events_ReportDisconnected_WhenOpenedWhileTheAgentIsOffline()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var ticket = await app.StreamTicketAsync();

        using var response = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));

        var state = (await reader.NextAsync())!;
        state.Data!.Value.GetProperty("connection").GetString().Should().Be("disconnected");
        state.Data!.Value.GetProperty("agentOnline").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Events_TellTheScreen_WhenACommandFindsTheAgentOffline()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody()));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var s = await app.GetAsync("/api/v1/tv/state");
            return (await TvApp.JsonAsync(s)).GetProperty("power").GetString() == "on";
        }, "estado recebido");

        var ticket = await app.StreamTicketAsync();
        using var response = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));
        (await reader.NextAsync())!.EventType.Should().Be("tv.state");
        (await reader.NextAsync())!.EventType.Should().Be("tv.shortcuts");

        await agent.DisposeAsync();
        await TvApp.WaitUntilAsync(() => app.Presence.Get(TvApp.AgentSlug)?.Connected == false, "agente caiu");

        // Uma leitura qualquer descobre a queda primeiro; o aviso à tela não pode se perder por causa disso.
        (await app.GetAsync("/api/v1/tv/state")).Dispose();
        var offline = (await reader.NextAsync())!;
        offline.EventType.Should().Be("tv.state");
        offline.Data!.Value.GetProperty("connection").GetString().Should().Be("disconnected");
        offline.Data!.Value.GetProperty("agentOnline").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Events_TellTheScreen_WhenACommandFindsTheAgentOffline_AndNothingReadItFirst()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody()));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var s = await app.GetAsync("/api/v1/tv/state");
            return (await TvApp.JsonAsync(s)).GetProperty("power").GetString() == "on";
        }, "estado recebido");

        var ticket = await app.StreamTicketAsync();
        using var response = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));
        (await reader.NextAsync())!.EventType.Should().Be("tv.state");
        (await reader.NextAsync())!.EventType.Should().Be("tv.shortcuts");

        await agent.DisposeAsync();
        await TvApp.WaitUntilAsync(() => app.Presence.Get(TvApp.AgentSlug)?.Connected == false, "agente caiu");
        (await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" })).Dispose();

        var offline = (await reader.NextAsync())!;
        offline.EventType.Should().Be("tv.state");
        offline.Data!.Value.GetProperty("connection").GetString().Should().Be("disconnected");
        offline.Data!.Value.GetProperty("agentOnline").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Events_PushDisconnected_TheMomentTheAgentDrops_WithoutAnyReadOrCommand()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody()));
        await TvApp.WaitUntilAsync(() => app.Services.GetRequiredService<UniOver.Modules.Tv.Ports.ITvStateStore>()
            .Last(TvApp.AgentSlug) is not null, "estado recebido");

        var ticket = await app.StreamTicketAsync();
        using var response = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));
        (await reader.NextAsync())!.EventType.Should().Be("tv.state");
        (await reader.NextAsync())!.EventType.Should().Be("tv.shortcuts");
        var before = await app.TvFingerprintAsync();

        await agent.DisposeAsync();

        // Nenhum GET e nenhum comando: o aviso vem da presença do Devices.
        var dropped = (await reader.NextAsync())!;
        dropped.EventType.Should().Be("tv.state");
        dropped.Data!.Value.GetProperty("connection").GetString().Should().Be("disconnected");
        dropped.Data!.Value.GetProperty("agentOnline").GetBoolean().Should().BeFalse();
        (await app.TvFingerprintAsync()).Should().Be(before, "a queda não escreve no banco");

        // E ao voltar, a tela também é avisada.
        await using var again = await app.ConnectAsync();
        var back = (await reader.NextAsync())!;
        back.EventType.Should().Be("tv.state");
        back.Data!.Value.GetProperty("agentOnline").GetBoolean().Should().BeTrue();
    }
}
