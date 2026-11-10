using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Adapters;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.Presence;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Ports;
using UniOver.Modules.Devices.Transport.WebSocket;

namespace UniOver.Modules.Devices.Tests.Transport;

/// <summary>Uma sessão que guarda o que o núcleo pediu e só termina de ler quando o teste manda.</summary>
internal sealed class RecordingSession(string agentId) : IAgentSession
{
    private readonly TaskCompletionSource _ended = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<AgentCloseReason> _closes = [];
    private readonly List<byte[]> _sent = [];

    public string AgentId { get; } = agentId;

    public IReadOnlyList<AgentCloseReason> Closes
    {
        get
        {
            lock (_closes)
            {
                return [.. _closes];
            }
        }
    }

    public IReadOnlyList<byte[]> Sent
    {
        get
        {
            lock (_sent)
            {
                return [.. _sent];
            }
        }
    }

    public async ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken)
    {
        await _ended.Task.WaitAsync(cancellationToken);
        return null;
    }

    public ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken)
    {
        lock (_sent)
        {
            _sent.Add(envelope.ToArray());
        }

        return ValueTask.FromResult(true);
    }

    public Task CloseAsync(AgentCloseReason reason, CancellationToken cancellationToken)
    {
        lock (_closes)
        {
            _closes.Add(reason);
        }

        return Task.CompletedTask;
    }

    /// <summary>O agente fechou do lado dele: a leitura do núcleo termina.</summary>
    public void End() => _ended.TrySetResult();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

/// <summary>O núcleo do transporte como um todo, com relógio falso e sem banco (a gravação do resumo só falha e é registrada).</summary>
internal sealed class RestartRig
{
    public static readonly DateTimeOffset Start = new(2026, 11, 10, 12, 0, 0, TimeSpan.Zero);

    public RestartRig(Action<DevicesTransportOptions>? configure = null)
    {
        var settings = new DevicesTransportOptions { PresenceGraceSeconds = 150 };
        configure?.Invoke(settings);
        Options = Microsoft.Extensions.Options.Options.Create(settings);
        Time = new FakeTimeProvider(Start);
        Presence = new InMemoryPresenceStore(Time, Options);
        Events = new SseBroadcaster<PresenceUpdate>(new SseStreamOptions());
        Connections = new AgentConnections(Presence, Events, null, Time, Options);
        Correlator = new ReplyCorrelator(Time, Options);
        var validator = new AgentEnvelopeValidator();
        Factory = new OutboundEnvelopeFactory(validator, new TimeProviderClock(Time));
        var scopes = new ServiceCollection().BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        Hub = new AgentHub(
            validator,
            Factory,
            Connections,
            new AgentPresencePersistence(scopes, NullLogger<AgentPresencePersistence>.Instance),
            Correlator,
            new InMemoryAgentLogReports(Time),
            scopes,
            Options,
            Time,
            NullLogger<AgentHub>.Instance);
    }

    public IOptions<DevicesTransportOptions> Options { get; }

    public FakeTimeProvider Time { get; }

    public InMemoryPresenceStore Presence { get; }

    public SseBroadcaster<PresenceUpdate> Events { get; }

    public AgentConnections Connections { get; }

    public ReplyCorrelator Correlator { get; }

    public OutboundEnvelopeFactory Factory { get; }

    public AgentHub Hub { get; }

    /// <summary>Sessão já registrada, com o <c>hello</c> declarando <paramref name="capabilities"/>.</summary>
    public RecordingSession Connect(string agentId, params string[] capabilities)
    {
        var session = new RecordingSession(agentId);
        Connections.Attach(session, Time.GetUtcNow());
        Connections.RecordHello(session, "1.0.0", capabilities, Time.GetUtcNow());
        return session;
    }

    /// <summary>Deixa as tarefas pendentes andarem (o tempo falso não passa sozinho).</summary>
    public static async Task SettleAsync()
    {
        for (var i = 0; i < 20; i++)
        {
            await Task.Yield();
        }

        await Task.Delay(10);
    }
}

public sealed class ServerRestartNoticeTests
{
    private const string Restart = "transport.restart.v1";

    [Fact]
    public async Task OnlyAgentsThatDeclaredTheCapabilityReceiveTheRestartClose_TheOthersKeepTheOldBehavior()
    {
        var rig = new RestartRig();
        var modern = rig.Connect("pc-novo", "transport.keepalive.v1", Restart);
        var old = rig.Connect("pc-velho", "transport.keepalive.v1");

        await rig.Hub.NotifyServerRestartAsync(TestContext.Current.CancellationToken);

        modern.Closes.Should().Equal(AgentCloseReason.ServerRestart);
        old.Closes.Should().BeEmpty("o agente antigo não conhece o 4411: segue recebendo o 1012 quando o serviço parar");
    }

    [Fact]
    public async Task TheNoticeWaitsForTheCommandsInFlight_ThenClosesTheSessions()
    {
        var rig = new RestartRig();
        var session = rig.Connect("pc-casa", Restart);
        var commandId = Guid.CreateVersion7();
        using var pending = rig.Correlator.Expect("pc-casa", commandId);

        var notice = rig.Hub.NotifyServerRestartAsync(TestContext.Current.CancellationToken);
        for (var i = 0; i < 5; i++)
        {
            rig.Time.Advance(TimeSpan.FromMilliseconds(100));
            await RestartRig.SettleAsync();
        }

        session.Closes.Should().BeEmpty("o resultado de um comando só chega pela conexão que o enviou: ele ainda está em curso");
        notice.IsCompleted.Should().BeFalse();

        rig.Correlator.TryComplete("pc-casa", commandId, new AgentReply(commandId, true, null)).Should().BeTrue();
        rig.Time.Advance(TimeSpan.FromMilliseconds(100));
        await notice.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        session.Closes.Should().Equal(AgentCloseReason.ServerRestart);
        (await pending.Reply).Ok.Should().BeTrue();
    }

    [Fact]
    public async Task TheNoticeGivesUpWaitingAfterTheDrainWindow_SoAStuckCommandNeverBlocksTheShutdown()
    {
        var rig = new RestartRig(o => o.DrainWaitSeconds = 3);
        var session = rig.Connect("pc-casa", Restart);
        using var pending = rig.Correlator.Expect("pc-casa", Guid.CreateVersion7());

        var notice = rig.Hub.NotifyServerRestartAsync(TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();
        rig.Time.Advance(TimeSpan.FromSeconds(2));
        await RestartRig.SettleAsync();
        session.Closes.Should().BeEmpty();

        for (var i = 0; i < 40 && !notice.IsCompleted; i++)
        {
            rig.Time.Advance(TimeSpan.FromMilliseconds(100));
            await RestartRig.SettleAsync();
        }

        await notice.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        session.Closes.Should().Equal(AgentCloseReason.ServerRestart);
    }

    [Fact]
    public async Task WithZeroDrainWait_TheAgentsAreToldAtOnce()
    {
        var rig = new RestartRig(o => o.DrainWaitSeconds = 0);
        var session = rig.Connect("pc-casa", Restart);
        using var pending = rig.Correlator.Expect("pc-casa", Guid.CreateVersion7());

        await rig.Hub.NotifyServerRestartAsync(TestContext.Current.CancellationToken);

        session.Closes.Should().Equal(AgentCloseReason.ServerRestart);
    }

    [Fact]
    public async Task ADrainingInstance_RefusesNewSessions_WithTheClassicRestartClose()
    {
        var rig = new RestartRig();
        await rig.Hub.NotifyServerRestartAsync(TestContext.Current.CancellationToken);
        var late = new RecordingSession("pc-casa");

        await rig.Hub.RunSessionAsync(late, TestContext.Current.CancellationToken);

        late.Closes.Should().Equal(AgentCloseReason.Shutdown); // o hello ainda não chegou: só o 1012, que todo agente entende, serve
        rig.Connections.TryGet("pc-casa", out _).Should().BeFalse("uma sessão aceita agora seria derrubada em seguida");
    }

    [Fact]
    public async Task TheStoppingEvent_StartsTheNotice_BeforeTheServicesStop()
    {
        var rig = new RestartRig(o => o.DrainWaitSeconds = 0);
        var session = rig.Connect("pc-casa", Restart);
        using var stopping = new CancellationTokenSource();
        var listener = new AgentTransportListener([new SilentTransport()], rig.Hub, new FakeLifetime(stopping.Token), NullLogger<AgentTransportListener>.Instance);
        await listener.StartAsync(TestContext.Current.CancellationToken);

        await stopping.CancelAsync();
        await RestartRig.SettleAsync();

        session.Closes.Should().Equal(AgentCloseReason.ServerRestart);
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await listener.StopAsync(cancel.Token);
    }

    [Fact]
    public void TheRestartCloseIs4411_WithTheReasonTheAgentRecognizes()
    {
        var (status, reason) = CloseCodes.For(AgentCloseReason.ServerRestart);

        ((int)status).Should().Be(4411);
        reason.Should().Be("server-restart");
        ((int)CloseCodes.For(AgentCloseReason.Shutdown).Status).Should().Be(1012, "o agente antigo segue recebendo o 1012");
    }

    private sealed class SilentTransport : IAgentTransport
    {
        public string Name => "silencioso";

        public async IAsyncEnumerable<IAgentSession> AcceptSessionsAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            yield break;
        }
    }

    private sealed class FakeLifetime(CancellationToken stopping) : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => TestContext.Current.CancellationToken;

        public CancellationToken ApplicationStopping => stopping;

        public CancellationToken ApplicationStopped => TestContext.Current.CancellationToken;

        public void StopApplication()
        {
        }
    }
}

public sealed class ReplyHoldTests
{
    [Fact]
    public async Task AnAgentThatDropsAndComesBackInsideTheHold_StillDeliversTheResultOfThePendingCommand()
    {
        var rig = new RestartRig();
        var first = new RecordingSession("pc-casa");
        var running = rig.Hub.RunSessionAsync(first, TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();
        var commandId = Guid.CreateVersion7();
        using var pending = rig.Correlator.Expect("pc-casa", commandId);
        pending.TryBeginSend(first).Should().BeTrue("o comando saiu pela sessão que vai cair");

        first.End();
        await running.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        rig.Time.Advance(TimeSpan.FromSeconds(2));
        pending.Reply.IsCompleted.Should().BeFalse("a conexão caiu, mas o agente costuma voltar em segundos: o comando espera");

        var second = new RecordingSession("pc-casa");
        var resumed = rig.Hub.RunSessionAsync(second, TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();
        rig.Time.Advance(TimeSpan.FromSeconds(10));
        pending.Reply.IsCompleted.Should().BeFalse("voltou: o prazo da queda já não vale para este comando");
        rig.Correlator.TryComplete("pc-casa", commandId, new AgentReply(commandId, true, null)).Should().BeTrue();
        (await pending.Reply).Ok.Should().BeTrue();

        second.End();
        await resumed.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task AnAgentThatDoesNotComeBackInTheHold_FailsTheCommandAsOffline()
    {
        var rig = new RestartRig();
        var session = new RecordingSession("pc-casa");
        var running = rig.Hub.RunSessionAsync(session, TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();
        using var pending = rig.Correlator.Expect("pc-casa", Guid.CreateVersion7());
        pending.TryBeginSend(session).Should().BeTrue();

        session.End();
        await running.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        rig.Time.Advance(TimeSpan.FromSeconds(4));
        pending.Reply.IsCompleted.Should().BeFalse();
        rig.Time.Advance(TimeSpan.FromSeconds(2));

        await pending.Invoking(p => p.Reply).Should().ThrowAsync<AgentDisconnectedException>();
    }

    [Fact]
    public async Task ARevokedAgent_FailsItsCommandsAtOnce_ItWillNotComeBack()
    {
        var rig = new RestartRig();
        var session = new RecordingSession("pc-casa");
        var running = rig.Hub.RunSessionAsync(session, TestContext.Current.CancellationToken);
        await RestartRig.SettleAsync();
        using var pending = rig.Correlator.Expect("pc-casa", Guid.CreateVersion7());

        await rig.Connections.CloseAsync("pc-casa", AgentCloseReason.Revoked, TestContext.Current.CancellationToken);
        session.End();
        await running.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        await pending.Invoking(p => p.Reply).Should().ThrowAsync<AgentDisconnectedException>();
    }

    [Fact]
    public void OnlyTheCommandsSentByTheSessionThatDropped_AreHeld()
    {
        var time = new FakeTimeProvider(RestartRig.Start);
        var correlator = new ReplyCorrelator(time, Options.Create(new DevicesTransportOptions()));
        var dropped = new object();
        var other = new object();
        using var sent = correlator.Expect("pc-casa", Guid.CreateVersion7());
        sent.TryBeginSend(dropped).Should().BeTrue();
        using var sentElsewhere = correlator.Expect("pc-casa", Guid.CreateVersion7());
        sentElsewhere.TryBeginSend(other).Should().BeTrue();
        using var notSentYet = correlator.Expect("pc-casa", Guid.CreateVersion7());

        correlator.Hold("pc-casa", dropped);
        using var createdAfter = correlator.Expect("pc-casa", Guid.CreateVersion7());
        time.Advance(TimeSpan.FromSeconds(6));

        sent.Reply.IsFaulted.Should().BeTrue("o prazo da queda acabou sem o agente voltar");
        sentElsewhere.Reply.IsCompleted.Should().BeFalse("saiu por outra sessão: a queda desta não é dele");
        notSentYet.Reply.IsCompleted.Should().BeFalse("ainda espera uma sessão para sair: segue o prazo da entrega");
        createdAfter.Reply.IsCompleted.Should().BeFalse("nasceu depois da queda: nunca entra no hold");
    }

    [Fact]
    public async Task AFailedWait_NeverLetsTheCommandBeSentAfterwards()
    {
        var correlator = new ReplyCorrelator(new FakeTimeProvider(RestartRig.Start), Options.Create(new DevicesTransportOptions()));
        using var pending = correlator.Expect("pc-casa", Guid.CreateVersion7());

        correlator.FailAll("pc-casa");

        pending.TryBeginSend(new object()).Should().BeFalse("a API já respondeu falha: o comando não pode sair depois");
        await pending.Invoking(p => p.Reply).Should().ThrowAsync<AgentDisconnectedException>();
    }

    [Fact]
    public async Task AfterAFail_TheCommandCannotBeSentNorCompleted_AndAReplyThatWonStays()
    {
        var correlator = new ReplyCorrelator(new FakeTimeProvider(RestartRig.Start), Options.Create(new DevicesTransportOptions()));
        var failed = Guid.CreateVersion7();
        var answered = Guid.CreateVersion7();
        using var failing = correlator.Expect("pc-casa", failed);
        using var replied = correlator.Expect("pc-casa", answered);
        correlator.TryComplete("pc-casa", answered, new AgentReply(answered, true, null)).Should().BeTrue();

        correlator.FailAll("pc-casa");

        failing.TryBeginSend(new object()).Should().BeFalse();
        correlator.TryComplete("pc-casa", failed, new AgentReply(failed, true, null)).Should().BeFalse("falhou: nenhuma resposta tardia vira sucesso");
        await failing.Invoking(p => p.Reply).Should().ThrowAsync<AgentDisconnectedException>();
        (await replied.Reply).Ok.Should().BeTrue("a resposta que chegou antes não é sobrescrita pela falha");
    }

    [Fact]
    public async Task TheFailureIsMarkedBeforeTheWaitLeavesTheCorrelator_SoAReconnectionCannotSqueezeASendInBetween()
    {
        // Interleaving controlado: o lock da espera é segurado pelo teste (por reflexão, é o ponto exato em que a reconexão
        // chamaria TryBeginSend). O FailAll tem de ficar parado AQUI, com a espera ainda no correlator, e só tirá-la depois de
        // marcar a falha; se removesse primeiro, haveria uma janela com a espera fora do dicionário e ainda enviável.
        var correlator = new ReplyCorrelator(new FakeTimeProvider(RestartRig.Start), Options.Create(new DevicesTransportOptions()));
        using var pending = correlator.Expect("pc-casa", Guid.CreateVersion7());
        var gate = pending.GetType().GetField("_gate", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(pending)!;

        Task failing;
        bool stillThere;
        bool finishedEarly;
        Monitor.Enter(gate);
        try
        {
            failing = Task.Run(() => correlator.FailAll("pc-casa"), TestContext.Current.CancellationToken);
            Thread.Sleep(300);
            finishedEarly = failing.IsCompleted;
            stillThere = !IsEmpty(correlator);
        }
        finally
        {
            Monitor.Exit(gate);
        }

        finishedEarly.Should().BeFalse("o FailAll espera a transição da espera, que o teste está segurando");
        stillThere.Should().BeTrue("a espera só sai do correlator depois de marcada como falha");
        await failing.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        pending.TryBeginSend(new object()).Should().BeFalse("a reconexão que liberasse o envio agora encontraria a falha já marcada");
        IsEmpty(correlator).Should().BeTrue();
    }

    /// <summary>O pedido com prazo zero termina na hora: verdadeiro se não há nenhuma espera no correlator.</summary>
    private static bool IsEmpty(ReplyCorrelator correlator)
    {
        var idle = correlator.WaitForIdleAsync(TimeSpan.Zero, CancellationToken.None);
        idle.IsCompletedSuccessfully.Should().BeTrue();
#pragma warning disable xUnit1031 // Já concluído de forma síncrona (prazo zero): não bloqueia.
        return idle.Result;
#pragma warning restore xUnit1031
    }

    [Fact]
    public async Task ZeroHold_FailsAtOnce_TheCommandsOfTheDroppedSession_LikeBefore()
    {
        var correlator = new ReplyCorrelator(new FakeTimeProvider(RestartRig.Start), Options.Create(new DevicesTransportOptions { ReplyHoldSeconds = 0 }));
        var session = new object();
        using var pending = correlator.Expect("pc-casa", Guid.CreateVersion7());
        pending.TryBeginSend(session);
        using var waiting = correlator.Expect("pc-casa", Guid.CreateVersion7());

        correlator.Hold("pc-casa", session);

        await pending.Invoking(p => p.Reply).Should().ThrowAsync<AgentDisconnectedException>();
        waiting.Reply.IsCompleted.Should().BeFalse("este ainda não saiu");
    }

    [Fact]
    public async Task WaitForIdle_ReturnsTrueWhenTheLastWaitEnds_AndFalseOnTimeout()
    {
        var time = new FakeTimeProvider(RestartRig.Start);
        var correlator = new ReplyCorrelator(time, Options.Create(new DevicesTransportOptions()));
        (await correlator.WaitForIdleAsync(TimeSpan.FromSeconds(1), TestContext.Current.CancellationToken)).Should().BeTrue("nada esperando");

        var pending = correlator.Expect("pc-casa", Guid.CreateVersion7());
        var timedOut = correlator.WaitForIdleAsync(TimeSpan.FromSeconds(1), TestContext.Current.CancellationToken);
        for (var i = 0; i < 30 && !timedOut.IsCompleted; i++)
        {
            time.Advance(TimeSpan.FromMilliseconds(50));
            await RestartRig.SettleAsync();
        }

        (await timedOut.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken)).Should().BeFalse();

        var done = correlator.WaitForIdleAsync(TimeSpan.FromSeconds(1), TestContext.Current.CancellationToken);
        pending.Dispose();
        for (var i = 0; i < 5 && !done.IsCompleted; i++)
        {
            time.Advance(TimeSpan.FromMilliseconds(50));
            await RestartRig.SettleAsync();
        }

        (await done.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken)).Should().BeTrue();
    }
}

public sealed class ImmediateCommandWaitTests
{
    private static readonly JsonElement Empty = JsonDocument.Parse("{}").RootElement.Clone();

    private static OutboundMessage Live() => new("tv.wake.v1", Empty, AgentDelivery.Immediate);

    private static AgentGateway Gateway(RestartRig rig) => new(
        rig.Connections, rig.Factory, rig.Correlator, rig.Options, rig.Time, NullLogger<AgentGateway>.Instance);

    [Fact]
    public async Task ALiveCommandRightAfterADrop_WaitsAFewSecondsForTheAgentToComeBack()
    {
        var rig = new RestartRig();
        var gateway = Gateway(rig);
        var first = rig.Connect("pc-casa");
        rig.Connections.Detach(first, rig.Time.GetUtcNow());

        var sending = gateway.SendAsync("pc-casa", Live(), TestContext.Current.CancellationToken);
        rig.Time.Advance(TimeSpan.FromSeconds(1));
        await RestartRig.SettleAsync();
        sending.IsCompleted.Should().BeFalse("a troca de instância leva menos que isto: o comando espera, não falha");

        var second = new RecordingSession("pc-casa");
        rig.Connections.Attach(second, rig.Time.GetUtcNow());
        (await sending.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken)).IsSuccess.Should().BeTrue();
        second.Sent.Should().ContainSingle();
    }

    [Fact]
    public async Task ALiveCommandFailsAsOfflineOnlyAfterTheShortWait()
    {
        var rig = new RestartRig();
        var gateway = Gateway(rig);
        var first = rig.Connect("pc-casa");
        rig.Connections.Detach(first, rig.Time.GetUtcNow());

        var sending = gateway.SendAsync("pc-casa", Live(), TestContext.Current.CancellationToken);
        rig.Time.Advance(TimeSpan.FromSeconds(4));
        await RestartRig.SettleAsync();
        sending.IsCompleted.Should().BeFalse();
        rig.Time.Advance(TimeSpan.FromSeconds(2));

        var result = await sending.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        result.IsFailure.Should().BeTrue();
        result.Error.Code.Should().Be(AgentErrors.OfflineCode);
    }

    [Fact]
    public async Task ALiveCommandToAnAgentThatWasAlreadyOffline_FailsAtOnce()
    {
        var rig = new RestartRig();
        var gateway = Gateway(rig);

        var result = await gateway.SendAsync("pc-casa", Live(), TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        result.IsFailure.Should().BeTrue("não estava na graça: nada a esperar");
    }

    [Fact]
    public async Task ZeroWait_KeepsTheOldBehavior_TheLiveCommandFailsAtOnce()
    {
        var rig = new RestartRig(o => o.ImmediateReconnectWaitSeconds = 0);
        var gateway = Gateway(rig);
        var first = rig.Connect("pc-casa");
        rig.Connections.Detach(first, rig.Time.GetUtcNow());

        var result = await gateway.SendAsync("pc-casa", Live(), TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        result.IsFailure.Should().BeTrue();
    }
}

public sealed class RestartOptionsTests
{
    [Fact]
    public void Defaults_AreTheShortWaitsOfTheDecision()
    {
        var options = new DevicesTransportOptions();

        options.ImmediateReconnectWait.Should().Be(TimeSpan.FromSeconds(5));
        options.ReplyHold.Should().Be(TimeSpan.FromSeconds(5));
        options.DrainWait.Should().Be(TimeSpan.FromSeconds(5));
        DevicesTransportOptions.IsValid(options).Should().BeTrue();
    }

    [Theory]
    [InlineData(-1, 5, 5)]
    [InlineData(5, -1, 5)]
    [InlineData(5, 5, -1)]
    [InlineData(61, 5, 5)]
    public void ValuesThatWouldBreakTheTransport_AreRefused(int immediate, int hold, int drain)
    {
        var options = new DevicesTransportOptions
        {
            ImmediateReconnectWaitSeconds = immediate,
            ReplyHoldSeconds = hold,
            DrainWaitSeconds = drain,
        };

        DevicesTransportOptions.IsValid(options).Should().BeFalse();
    }
}

public sealed class SseRetryTests
{
    private static async Task<string> RunAsync(SseStreamOptions options, int? publish)
    {
        var broadcaster = new SseBroadcaster<int>(options);
        using var subscription = broadcaster.Subscribe("dono");
        var context = new DefaultHttpContext();
        using var body = new MemoryStream();
        context.Response.Body = body;
        using var stopping = new CancellationTokenSource();

        var streaming = SseResults.Stream(subscription, options, TimeProvider.System, stopping.Token).ExecuteAsync(context);
        if (publish is { } value)
        {
            broadcaster.Publish(new SseMessage<int>("teste", value));
        }

        await Task.Delay(100, TestContext.Current.CancellationToken);
        await stopping.CancelAsync();
        await streaming.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        return System.Text.Encoding.UTF8.GetString(body.ToArray());
    }

    [Fact]
    public async Task TheStreamTellsTheBrowserHowSoonToReopen_BeforeAnyEvent()
    {
        var text = await RunAsync(new SseStreamOptions(), publish: 7);

        text.Should().StartWith("retry: 1000\n\n").And.Contain("event: teste\ndata: 7\n\n");
    }

    [Fact]
    public async Task ZeroRetry_SendsNoRetryField()
    {
        var text = await RunAsync(new SseStreamOptions { RetryMilliseconds = 0 }, publish: 7);

        text.Should().NotContain("retry:").And.StartWith("event: teste");
    }

    [Fact]
    public void TheRetryDefaultIsShort_AndANegativeValueIsRefused()
    {
        new SseStreamOptions().RetryMilliseconds.Should().Be(1000);
        new SseStreamOptions { RetryMilliseconds = -1 }.IsValid().Should().BeFalse();
    }
}
