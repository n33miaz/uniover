using System.Net.WebSockets;
using System.Security.Claims;
using System.Text.Json;
using System.Threading.Channels;
using AwesomeAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Ports;
using UniOver.Modules.Devices.Transport.WebSocket;

namespace UniOver.Modules.Devices.Tests.Transport;

/// <summary>
/// A intercalação real entre a queda da conexão e um comando que chega no meio dela: o comando criado depois da queda nunca
/// entra no prazo da queda, e um comando cuja espera já falhou nunca é enviado depois.
/// </summary>
public sealed class CommandAcrossADropTests
{
    private static readonly JsonElement Empty = JsonDocument.Parse("{}").RootElement.Clone();

    private static OutboundMessage Wake() => new("tv.wake.v1", Empty);

    private static AgentGateway Gateway(RestartRig rig) => new(
        rig.Connections, rig.Factory, rig.Correlator, rig.Options, rig.Time, NullLogger<AgentGateway>.Instance);

    [Fact]
    public async Task ACommandCreatedBetweenTheDetachAndTheHold_IsNotHeld_AndIsDeliveredWhenTheAgentComesBackLate()
    {
        var rig = new RestartRig();
        var gateway = Gateway(rig);
        var first = rig.Connect("pc-casa");

        // A ordem real do hub: a sessão sai do registro (Detach) e só depois vem o Hold. No meio, chega um comando.
        rig.Connections.Detach(first, rig.Time.GetUtcNow()).Should().BeTrue();
        var request = gateway.RequestAsync("pc-casa", Wake(), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();
        rig.Correlator.Hold("pc-casa", first);

        rig.Time.Advance(TimeSpan.FromSeconds(6));
        await RestartRig.SettleAsync();
        request.IsCompleted.Should().BeFalse("o comando ainda não saiu: segue a espera por sessão (25 s), não o prazo da queda (5 s)");

        var second = new RecordingSession("pc-casa");
        rig.Connections.Attach(second, rig.Time.GetUtcNow());
        await RestartRig.SettleAsync();
        var frame = second.Sent.Should().ContainSingle("o comando sai assim que há sessão, e só uma vez").Subject;
        var commandId = JsonDocument.Parse(frame).RootElement.GetProperty("id").GetGuid();
        rig.Correlator.TryComplete("pc-casa", commandId, new AgentReply(commandId, true, null)).Should().BeTrue();

        var result = await request.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        result.IsSuccess.Should().BeTrue("a API não respondeu falha antes de o comando sair");
    }

    [Fact]
    public async Task ACommandHeldWhileTheAgentIsAway_IsStampedWhenItLeaves_WithTheSameId()
    {
        // O agente mede a idade de uma tecla desde o `ts`: o comando que esperou a sessão voltar (deploy, queda curta) sai
        // carimbado na hora da saída, senão toda tecla da reconexão chegaria velha e seria descartada calada. O `id` é o mesmo
        // que a espera da resposta aguarda.
        var rig = new RestartRig();
        var gateway = Gateway(rig);
        var first = rig.Connect("pc-casa");
        rig.Connections.Detach(first, rig.Time.GetUtcNow()).Should().BeTrue();
        var sentAt = rig.Time.GetUtcNow();
        var request = gateway.RequestAsync("pc-casa", Wake(), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();

        rig.Time.Advance(TimeSpan.FromSeconds(6));
        await RestartRig.SettleAsync();
        var second = new RecordingSession("pc-casa");
        rig.Connections.Attach(second, rig.Time.GetUtcNow());
        await RestartRig.SettleAsync();

        var frame = JsonDocument.Parse(second.Sent.Should().ContainSingle().Subject).RootElement;
        frame.GetProperty("ts").GetDateTimeOffset().Should().Be(sentAt.AddSeconds(6), "o carimbo é o da saída, não o do pedido");
        var commandId = frame.GetProperty("id").GetGuid();
        rig.Correlator.TryComplete("pc-casa", commandId, new AgentReply(commandId, true, null)).Should().BeTrue();
        (await request.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken)).IsSuccess.Should().BeTrue();
    }

    [Fact]
    public async Task ACommandThatAlreadyFailedToTheCaller_IsNeverSentWhenTheAgentComesBack()
    {
        var rig = new RestartRig();
        var gateway = Gateway(rig);
        var first = rig.Connect("pc-casa");
        rig.Connections.Detach(first, rig.Time.GetUtcNow());
        var request = gateway.RequestAsync("pc-casa", Wake(), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();

        // O agente é dado como perdido de vez (sem graça de volta): a espera falha e a entrega que aguardava a sessão para.
        rig.Correlator.FailAll("pc-casa");
        var result = await request.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        result.IsFailure.Should().BeTrue();
        result.Error.Code.Should().Be(AgentErrors.OfflineCode);

        var second = new RecordingSession("pc-casa");
        rig.Connections.Attach(second, rig.Time.GetUtcNow());
        await RestartRig.SettleAsync();

        second.Sent.Should().BeEmpty("a API já respondeu falha: enviar agora executaria uma ação que a pessoa julga que falhou");
    }

    [Fact]
    public async Task ACommandSentBeforeTheDrop_IsHeld_AndItsResultStillArrivesThroughTheNewSession()
    {
        var rig = new RestartRig();
        var gateway = Gateway(rig);
        var first = rig.Connect("pc-casa");
        var request = gateway.RequestAsync("pc-casa", Wake(), TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();
        var commandId = JsonDocument.Parse(first.Sent.Single()).RootElement.GetProperty("id").GetGuid();

        rig.Connections.Detach(first, rig.Time.GetUtcNow());
        rig.Correlator.Hold("pc-casa", first);
        rig.Time.Advance(TimeSpan.FromSeconds(2));
        var second = new RecordingSession("pc-casa");
        rig.Connections.Attach(second, rig.Time.GetUtcNow());
        rig.Correlator.Release("pc-casa");
        rig.Time.Advance(TimeSpan.FromSeconds(10));
        request.IsCompleted.Should().BeFalse();

        rig.Correlator.TryComplete("pc-casa", commandId, new AgentReply(commandId, true, null)).Should().BeTrue();
        (await request.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken)).IsSuccess.Should().BeTrue();
    }
}

/// <summary>
/// A corrida do desligamento com um transporte WebSocket de verdade (a sessão real sobre um soquete que só registra): com um
/// comando em curso, o agente que entende o 4411 recebe o 4411, nunca o 1012 antecipado pelo endpoint ou pelo cancelamento.
/// </summary>
public sealed class ShutdownRaceTests
{
    private const string Restart = "transport.restart.v1";

    private static async Task UntilAsync(Func<bool> condition, RestartRig rig, int stepMilliseconds = 100)
    {
        for (var i = 0; i < 200 && !condition(); i++)
        {
            rig.Time.Advance(TimeSpan.FromMilliseconds(stepMilliseconds));
            await RestartRig.SettleAsync();
        }

        condition().Should().BeTrue("a condição deveria ter sido atingida");
    }

    [Fact]
    public async Task WithACommandInFlight_TheCapableAgentGetsThe4411_AndNeverAnEarly1012()
    {
        var rig = new RestartRig();
        var socket = new FakeWebSocket(sendHangs: false, abortUnblocksSend: true);
        var session = new WebSocketAgentSession("pc-casa", socket, rig.Options.Value);
        var transport = new HandOverTransport();
        using var stopping = new CancellationTokenSource();
        var listener = new AgentTransportListener([transport], rig.Hub, new FakeLifetime(stopping.Token), NullLogger<AgentTransportListener>.Instance);
        await listener.StartAsync(TestContext.Current.CancellationToken);
        transport.Hand(session);
        await UntilAsync(() => rig.Connections.TryGet("pc-casa", out _), rig, stepMilliseconds: 1);
        rig.Connections.TryGet("pc-casa", out var attached).Should().BeTrue();
        rig.Connections.RecordHello(attached, "1.0.0", [Restart], rig.Time.GetUtcNow());
        var commandId = Guid.CreateVersion7();
        using var pending = rig.Correlator.Expect("pc-casa", commandId);
        pending.TryBeginSend(attached).Should().BeTrue();

        // Como o host: o SIGTERM dispara o ApplicationStopping e, em seguida, o StopAsync dos serviços.
        await stopping.CancelAsync();
        var stop = listener.StopAsync(TestContext.Current.CancellationToken);
        for (var i = 0; i < 10; i++)
        {
            rig.Time.Advance(TimeSpan.FromMilliseconds(100));
            await RestartRig.SettleAsync();
        }

        socket.Closes.Should().BeEmpty("o hub ainda drena o comando em curso: ninguém pode ter fechado a sessão com o 1012");
        stop.IsCompleted.Should().BeFalse("o cancelamento das sessões espera o aviso terminar");

        rig.Correlator.TryComplete("pc-casa", commandId, new AgentReply(commandId, true, null)).Should().BeTrue();
        await UntilAsync(() => socket.Closes.Count > 0, rig);

        socket.Closes.Should().ContainSingle();
        ((int)socket.Closes[0].Status).Should().Be(4411);
        socket.Closes[0].Reason.Should().Be("server-restart");
        socket.PeerClosesOutput();
        await stop.WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task WithACommandInFlight_AnOldAgentKeepsTheClassic1012_AfterTheDrain()
    {
        var rig = new RestartRig();
        var socket = new FakeWebSocket(sendHangs: false, abortUnblocksSend: true);
        var session = new WebSocketAgentSession("pc-velho", socket, rig.Options.Value);
        var transport = new HandOverTransport();
        using var stopping = new CancellationTokenSource();
        var listener = new AgentTransportListener([transport], rig.Hub, new FakeLifetime(stopping.Token), NullLogger<AgentTransportListener>.Instance);
        await listener.StartAsync(TestContext.Current.CancellationToken);
        transport.Hand(session);
        await UntilAsync(() => rig.Connections.TryGet("pc-velho", out _), rig, stepMilliseconds: 1);
        rig.Connections.TryGet("pc-velho", out var attached).Should().BeTrue();
        rig.Connections.RecordHello(attached, "0.9.0", ["transport.keepalive.v1"], rig.Time.GetUtcNow());
        var commandId = Guid.CreateVersion7();
        using var pending = rig.Correlator.Expect("pc-velho", commandId);
        pending.TryBeginSend(attached).Should().BeTrue();

        await stopping.CancelAsync();
        var stop = listener.StopAsync(TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();
        socket.Closes.Should().BeEmpty("durante o dreno ninguém fecha");

        rig.Correlator.TryComplete("pc-velho", commandId, new AgentReply(commandId, true, null)).Should().BeTrue();
        await UntilAsync(() => socket.Closes.Count > 0, rig);

        ((int)socket.Closes[0].Status).Should().Be(1012, "quem não declarou a capacidade segue com o código de sempre");
        socket.PeerClosesOutput();
        await stop.WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task ThroughTheRealWebSocketTransport_ACommandInFlightIsDrained_ThenTheAgentGetsThe4411()
    {
        var rig = new RestartRig();
        var socket = new FakeWebSocket(sendHangs: false, abortUnblocksSend: true);
        using var stopping = new CancellationTokenSource();
        var lifetime = new FakeLifetime(stopping.Token);
        var transport = new WebSocketAgentTransport(Microsoft.Extensions.Options.Options.Create(rig.Options.Value), lifetime);
        var listener = new AgentTransportListener([transport], rig.Hub, lifetime, NullLogger<AgentTransportListener>.Instance);
        await listener.StartAsync(TestContext.Current.CancellationToken);

        // A sessão chega pelo endpoint real (HandleAsync), é conduzida pelo hub e o agente declara a capacidade.
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpWebSocketFeature>(new FakeWebSocketFeature(socket));
        context.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(DeviceAuth.SlugClaim, "pc-casa")], "teste"));
        var request = transport.HandleAsync(context);
        await UntilAsync(() => rig.Connections.TryGet("pc-casa", out _), rig, stepMilliseconds: 1);
        rig.Connections.TryGet("pc-casa", out var attached).Should().BeTrue();
        rig.Connections.RecordHello(attached, "1.0.0", [Restart], rig.Time.GetUtcNow());
        var commandId = Guid.CreateVersion7();
        using var pending = rig.Correlator.Expect("pc-casa", commandId);
        pending.TryBeginSend(attached).Should().BeTrue();

        await stopping.CancelAsync();
        var stop = listener.StopAsync(TestContext.Current.CancellationToken);
        for (var i = 0; i < 10; i++)
        {
            rig.Time.Advance(TimeSpan.FromMilliseconds(100));
            await RestartRig.SettleAsync();
        }

        socket.Closes.Should().BeEmpty("nem o endpoint nem o cancelamento fecham enquanto o comando está em curso");
        request.IsCompleted.Should().BeFalse();

        rig.Correlator.TryComplete("pc-casa", commandId, new AgentReply(commandId, true, null)).Should().BeTrue();
        await UntilAsync(() => socket.Closes.Count > 0, rig);

        socket.Closes.Should().ContainSingle();
        ((int)socket.Closes[0].Status).Should().Be(4411);
        socket.Closes[0].Reason.Should().Be("server-restart");
        socket.PeerClosesOutput();
        await stop.WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
        await request.WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task TheEndpoint_DoesNotCloseTheSessionOnItsOwn_WhenTheApplicationIsStopping()
    {
        var socket = new FakeWebSocket(sendHangs: false, abortUnblocksSend: true);
        using var stopping = new CancellationTokenSource();
        var options = Microsoft.Extensions.Options.Options.Create(new DevicesTransportOptions());
        var transport = new WebSocketAgentTransport(options, new FakeLifetime(stopping.Token));
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpWebSocketFeature>(new FakeWebSocketFeature(socket));
        context.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(DeviceAuth.SlugClaim, "pc-casa")], "teste"));

        var request = transport.HandleAsync(context);
        IAgentSession? session = null;
        await foreach (var accepted in transport.AcceptSessionsAsync(TestContext.Current.CancellationToken))
        {
            session = accepted;
            break;
        }

        session.Should().NotBeNull();

        await stopping.CancelAsync();
        await Task.Delay(300, TestContext.Current.CancellationToken);

        socket.Closes.Should().BeEmpty("quem decide entre 4411 e 1012 é o hub, depois de drenar: o endpoint só espera a sessão acabar");
        request.IsCompleted.Should().BeFalse();

        socket.PeerClosesOutput();
        await session!.DisposeAsync();
        await request.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    private sealed class HandOverTransport : IAgentTransport
    {
        private readonly Channel<IAgentSession> _sessions = Channel.CreateUnbounded<IAgentSession>();

        public string Name => "entregue";

        public void Hand(IAgentSession session) => _sessions.Writer.TryWrite(session);

        public IAsyncEnumerable<IAgentSession> AcceptSessionsAsync(CancellationToken cancellationToken) =>
            _sessions.Reader.ReadAllAsync(cancellationToken);
    }

    private sealed class FakeWebSocketFeature(System.Net.WebSockets.WebSocket socket) : IHttpWebSocketFeature
    {
        public bool IsWebSocketRequest => true;

        public Task<System.Net.WebSockets.WebSocket> AcceptAsync(WebSocketAcceptContext context) => Task.FromResult(socket);
    }

    private sealed class FakeLifetime(CancellationToken stopping) : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => stopping;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication()
        {
        }
    }
}
