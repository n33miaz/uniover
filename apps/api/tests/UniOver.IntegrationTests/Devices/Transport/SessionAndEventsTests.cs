using System.Net;
using System.Net.WebSockets;
using System.Data.Common;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Devices.Transport;

[Collection(PostgresGroup.Name)]
public sealed class SessionAndEventsTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task SecondConnectionOfTheSameAgent_ReplacesTheFirst_WithoutAFalseDisconnect()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var ticket = await app.StreamTicketAsync();
        using var events = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await events.Content.ReadAsStreamAsync(Ct));
        (await reader.NextAsync())!.EventType.Should().Be("agent.presence.snapshot");

        await using var first = await app.ConnectAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == true, "primeira conectada");
        await using var second = await app.ConnectAsync();

        // Conexão comum (reconexão): a nova assume na hora e a antiga sai sem esperar nenhum quadro.
        var closed = await first.WaitForCloseAsync();
        closed.Description.Should().Be("replaced");
        closed.Status.Should().Be((WebSocketCloseStatus)4409);

        // A antiga terminou de se desmontar; a presença continua de pé por causa da nova.
        await second.SendHelloAsync("7.0.0");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "7.0.0", "hello da nova");
        app.Presence.Get(app.Agent.Slug)!.Connected.Should().BeTrue();

        await second.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "desconectada de verdade");

        // No SSE, a única queda é a final: tudo antes dela é "conectado".
        var states = new List<bool>();
        while (true)
        {
            var frame = (await reader.NextAsync())!;
            var connected = frame.Data!.Value.GetProperty("agents")[0].GetProperty("connected").GetBoolean();
            states.Add(connected);
            if (!connected)
            {
                break;
            }
        }

        states.Count(c => !c).Should().Be(1);
        states.Count(c => c).Should().BeGreaterThanOrEqualTo(2);
    }

    [Fact]
    public async Task HelloWithHandover_ClosesTheOldWith4410_AndTheNewKeepsThePresence()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var ticket = await app.StreamTicketAsync();
        using var events = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await events.Content.ReadAsStreamAsync(Ct));
        (await reader.NextAsync())!.EventType.Should().Be("agent.presence.snapshot");

        await using var first = await app.ConnectAsync();
        // A antiga declara entender o 4410: só então a API a fecha com ele.
        await first.SendHelloAsync("7.0.0", "agent.handover.v1");
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("agent.handover.v1") == true, "hello da primeira");
        await using var second = await app.ConnectAsync(candidate: true);

        // Candidata: até o hello a antiga segue a atual e aberta.
        await Task.Delay(200, Ct);
        first.State.Should().Be(WebSocketState.Open);
        await second.SendHandoverHelloAsync("7.1.0");
        // A nova recebe a confirmação da promoção (é por ela que o agente deixa de ser candidato).
        var ack = await second.ReceiveAsync();
        ack!.Value.GetProperty("type").GetString().Should().Be("agent.handover.accepted.v1");
        ack.Value.GetProperty("body").GetProperty("instanceId").GetString().Should().NotBeNullOrEmpty();
        var closed = await first.WaitForCloseAsync();
        closed.Description.Should().Be("handover");
        closed.Status.Should().Be((WebSocketCloseStatus)4410);

        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "7.1.0", "hello da nova");
        app.Presence.Get(app.Agent.Slug)!.Connected.Should().BeTrue();

        await second.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "desconectada de verdade");

        // No SSE, a única queda é a final: a saída da antiga na passagem nunca anuncia desconexão.
        var states = new List<bool>();
        while (true)
        {
            var frame = (await reader.NextAsync())!;
            var connected = frame.Data!.Value.GetProperty("agents")[0].GetProperty("connected").GetBoolean();
            states.Add(connected);
            if (!connected)
            {
                break;
            }
        }

        states.Count(c => !c).Should().Be(1);
    }

    [Fact]
    public async Task HelloWithHandover_ClosesAnOldThatNeverDeclaredTheCapabilityWith4409()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var first = await app.ConnectAsync();
        await first.SendHelloAsync("7.0.0");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "7.0.0", "hello da antiga");

        await using var second = await app.ConnectAsync(candidate: true);
        await second.SendHandoverHelloAsync("7.1.0");
        (await second.ReceiveAsync())!.Value.GetProperty("type").GetString().Should().Be("agent.handover.accepted.v1");

        // Sem a capacidade a antiga não entenderia o 4410: sai como substituída, que toda versão entende.
        var closed = await first.WaitForCloseAsync();
        closed.Description.Should().Be("replaced");
        closed.Status.Should().Be((WebSocketCloseStatus)4409);
    }

    [Fact]
    public async Task ACandidateThatDropsBeforeItsHello_LeavesTheOldSessionOpenAndTheAgentConnected()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var first = await app.ConnectAsync();
        await first.SendHelloAsync("7.0.0");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "7.0.0", "hello da antiga");

        await using var candidate = await app.ConnectAsync(candidate: true);
        await candidate.DisposeAsync();
        await Task.Delay(500, Ct);

        first.State.Should().Be(WebSocketState.Open, "a antiga nunca fecha por causa de uma candidata que caiu");
        first.Closed.Should().BeNull();
        app.Presence.Get(app.Agent.Slug)!.Connected.Should().BeTrue();
    }

    [Fact]
    public async Task RevokingTheAgent_ClosesTheLiveSession()
    {
        var outbox = new OutboxClaimBarrier();
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { CommandInterceptor = outbox });
        await using var agent = await app.ConnectAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == true, "conectado");
        await app.App.WaitForOutboxAsync(expectedProcessed: 1);

        outbox.Arm();
        using var revoke = await app.App.RevokeRawAsync(app.Login, app.Agent.Id, "perdi o aparelho");
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);

        await outbox.WaitForClaimAsync(Ct);
        var closed = await agent.WaitForCloseAsync();
        closed.Description.Should().Be("revoked");
        closed.Status.Should().Be((WebSocketCloseStatus)4403);
        outbox.IsBlocked.Should().BeTrue("the session must close locally before the outbox handler is released");
        outbox.Release();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "presença derrubada");
    }

    [Fact]
    public async Task Events_WithoutTheStreamCookie_Return401_AndNeverAcceptATokenInTheUrl()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        using var anonymous = await app.OpenEventsAsync(cookieTicket: null);
        using var jwtInQuery = await app.OpenEventsAsync(cookieTicket: null, query: $"?access_token={app.Login.AccessToken}");
        var ticket = await app.StreamTicketAsync();
        using var ticketInQuery = await app.OpenEventsAsync(cookieTicket: null, query: $"?uo_st={ticket}&access_token={ticket}");

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        jwtInQuery.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        ticketInQuery.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // O JWT de acesso no cabeçalho também não abre o stream: só o bilhete em cookie.
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/devices/events");
        request.Headers.Authorization = new("Bearer", app.Login.AccessToken);
        using var bearer = await app.App.Client.SendAsync(request, Ct);
        bearer.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Events_SendASnapshotAndThenPresenceChanges()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var other = await app.PairAnotherAsync("Outro PC");
        await using var agent = await app.ConnectAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == true, "conectado");

        var ticket = await app.StreamTicketAsync();
        using var response = await app.OpenEventsAsync(ticket);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.MediaType.Should().Be("text/event-stream");
        using var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));

        var snapshot = (await reader.NextAsync())!;
        snapshot.EventType.Should().Be("agent.presence.snapshot");
        var agents = snapshot.Data!.Value.GetProperty("agents");
        agents.GetArrayLength().Should().Be(1);
        agents[0].GetProperty("agentId").GetString().Should().Be(app.Agent.Slug);
        agents[0].GetProperty("connected").GetBoolean().Should().BeTrue();

        await using var second = await FakeAgent.ConnectAsync(app.Server, other.Slug, other.Token);
        var change = (await reader.NextAsync())!;
        change.EventType.Should().Be("agent.presence");
        change.Data!.Value.GetProperty("agents")[0].GetProperty("agentId").GetString().Should().Be(other.Slug);

        await second.SendHelloAsync("5.1.0", "tv.remote");
        var hello = (await reader.NextAsync())!;
        hello.Data!.Value.GetProperty("agents")[0].GetProperty("agentVersion").GetString().Should().Be("5.1.0");
    }

    [Fact]
    public async Task Events_SendAKeepAliveComment_AndEndAfterTenMinutes()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var ticket = await app.StreamTicketAsync();
        using var response = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));
        (await reader.NextAsync())!.EventType.Should().Be("agent.presence.snapshot");

        var keepAlive = reader.NextAsync();
        while (!keepAlive.IsCompleted)
        {
            app.App.Time.Advance(TimeSpan.FromSeconds(15));
            await Task.Delay(25, Ct);
        }

        (await keepAlive)!.Comment.Should().Be("keep-alive");

        // Passados os 10 minutos o servidor encerra sozinho para forçar um bilhete novo; até lá só chegam keep-alives.
        var frames = 0;
        while (true)
        {
            var next = reader.NextAsync();
            while (!next.IsCompleted)
            {
                app.App.Time.Advance(TimeSpan.FromMinutes(1));
                await Task.Delay(25, Ct);
            }

            if (await next is null)
            {
                break;
            }

            frames++;
            frames.Should().BeLessThan(100, "o fluxo precisa terminar sozinho");
        }
    }

    [Fact]
    public async Task Events_CloseTheOldestStream_WhenTheUserOpensMoreThanThree()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var ticket = await app.StreamTicketAsync();

        var responses = new List<HttpResponseMessage>();
        var readers = new List<SseReader>();
        try
        {
            for (var i = 0; i < 4; i++)
            {
                var response = await app.OpenEventsAsync(ticket);
                responses.Add(response);
                var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));
                readers.Add(reader);
                (await reader.NextAsync())!.EventType.Should().Be("agent.presence.snapshot");
            }

            // O primeiro foi fechado pelo servidor; os outros três seguem abertos.
            (await readers[0].NextAsync()).Should().BeNull();
            await using var agent = await app.ConnectAsync();
            foreach (var reader in readers.Skip(1))
            {
                (await reader.NextAsync())!.EventType.Should().Be("agent.presence");
            }
        }
        finally
        {
            readers.ForEach(r => r.Dispose());
            responses.ForEach(r => r.Dispose());
        }
    }

    [Fact]
    public async Task Presence_WritesTheLastContactOnlyOnConnectionChangesAndNewHello_NeverPerHeartbeat()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var connectedAt = app.App.Time.GetUtcNow();
        await using var agent = await app.ConnectAsync();
        await TransportApp.WaitUntilAsync(async () =>
        {
            await using var db = app.App.Db();
            return await db.AgentPresenceSnapshots.AnyAsync(x => x.AgentId == app.Agent.Id, Ct);
        }, "conexão persistida");

        async Task<DateTimeOffset?> LastSeenAsync()
        {
            await using var db = app.App.Db();
            return await db.AgentPresenceSnapshots.Where(x => x.AgentId == app.Agent.Id).Select(x => x.LastSeenAt).SingleAsync(Ct);
        }

        (await LastSeenAsync()).Should().Be(connectedAt);

        // Batimentos (inclusive depois de passar muito mais de um minuto): o "visto agora" fica na memória e o banco não muda.
        foreach (var step in new[] { TimeSpan.FromSeconds(25), TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(30) })
        {
            app.App.Time.Advance(step);
            var expected = app.App.Time.GetUtcNow();
            await agent.SendTextAsync(agent.Envelope("agent.keepalive.v1", new System.Text.Json.Nodes.JsonObject()));
            await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.LastMessageAt == expected, "batimento recebido");
            app.Presence.Get(app.Agent.Slug)!.LastMessageAt.Should().Be(expected, "a presença em memória segue viva para a tela");
        }

        await Task.Delay(200, Ct);
        (await LastSeenAsync()).Should().Be(connectedAt, "batimento nenhum chega ao banco");

        // Um hello com novidade (versão) é gravado e renova o último sinal.
        var helloAt = app.App.Time.GetUtcNow();
        await agent.SendHelloAsync("3.0.0", "tv.remote");
        await TransportApp.WaitUntilAsync(async () => await LastSeenAsync() == helloAt, "hello novo persistido");

        // Desconectar grava o último sinal.
        app.App.Time.Advance(TimeSpan.FromSeconds(10));
        var droppedAt = app.App.Time.GetUtcNow();
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(async () => await LastSeenAsync() == droppedAt, "desconexão persistida");
    }

    [Fact]
    public async Task RepeatedIdenticalHello_AndHeartbeats_DoNotRewriteTheSummary()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("1.0.0", "tv.remote");
        await TransportApp.WaitUntilAsync(async () =>
        {
            await using var db = app.App.Db();
            return await db.AgentPresenceSnapshots.AnyAsync(
                x => x.AgentId == app.Agent.Id && x.AgentVersion == "1.0.0", Ct);
        }, "hello persistido");
        var before = await app.SnapshotRowVersionAsync();
        var seenBefore = app.App.Time.GetUtcNow();

        // O hello repetido (como o agente faz a cada 5 min) e o batimento não gravam nada, nem passados vários minutos.
        app.App.Time.Advance(TimeSpan.FromMinutes(5));
        await agent.SendHelloAsync("1.0.0", "tv.remote");
        await agent.SendTextAsync(agent.Envelope("agent.keepalive.v1", new System.Text.Json.Nodes.JsonObject()));
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.LastMessageAt > seenBefore,
            "mensagens processadas");

        (await app.SnapshotRowVersionAsync()).Should().Be(before);
    }
}

internal sealed class OutboxClaimBarrier : DbCommandInterceptor
{
    private readonly TaskCompletionSource _claimed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _armed;
    private int _blocked;

    public bool IsBlocked => Volatile.Read(ref _blocked) == 1;

    public void Arm() => Volatile.Write(ref _armed, 1);

    public void Release() => _release.TrySetResult();

    public async Task WaitForClaimAsync(CancellationToken cancellationToken) =>
        await _claimed.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);

    public override async ValueTask<DbDataReader> ReaderExecutedAsync(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result,
        CancellationToken cancellationToken = default)
    {
        if (Volatile.Read(ref _armed) != 0
            && result.HasRows
            && command.CommandText.Contains("outbox_messages", StringComparison.OrdinalIgnoreCase)
            && command.CommandText.Contains("SKIP LOCKED", StringComparison.OrdinalIgnoreCase)
            && Interlocked.CompareExchange(ref _blocked, 1, 0) == 0)
        {
            _claimed.TrySetResult();
            await _release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
        }

        return result;
    }
}
