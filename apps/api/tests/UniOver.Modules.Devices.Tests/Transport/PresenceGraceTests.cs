using AwesomeAssertions;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Adapters;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.Presence;
using UniOver.Modules.Devices.Ports;

namespace UniOver.Modules.Devices.Tests.Transport;

/// <summary>
/// Quedas curtas da conexão (deploy, troca de instância, rede) não são "agente fora do ar": a presença segue verde
/// durante a graça e nenhuma queda é anunciada. Só a queda que passa da graça vale, com o instante em que a conexão caiu.
/// </summary>
public sealed class PresenceGraceTests
{
    private static readonly DateTimeOffset Start = new(2026, 10, 28, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Grace = TimeSpan.FromSeconds(8);

    private sealed class Rig
    {
        public Rig(int graceSeconds = 8)
        {
            Time = new FakeTimeProvider(Start);
            var options = Options.Create(new DevicesTransportOptions { PresenceGraceSeconds = graceSeconds });
            Presence = new InMemoryPresenceStore(Time, options);
            Events = new SseBroadcaster<PresenceUpdate>(new SseStreamOptions());
            Connections = new AgentConnections(Presence, Events, null, Time, options);
        }

        public FakeTimeProvider Time { get; }

        public InMemoryPresenceStore Presence { get; }

        public SseBroadcaster<PresenceUpdate> Events { get; }

        public AgentConnections Connections { get; }

        public bool Connected => Presence.Get("pc-casa")!.Connected;
    }

    [Fact]
    public void ADropInsideTheGrace_KeepsTheAgentConnected_AndAnnouncesNoDrop()
    {
        var rig = new Rig();
        var first = new StubSession("pc-casa");
        rig.Connections.Attach(first, Start);
        rig.Connections.RecordHello(first, "1.0.0", ["tv.remote"], Start);
        using var stream = rig.Events.Subscribe("dono");

        rig.Time.Advance(TimeSpan.FromSeconds(5));
        rig.Connections.Detach(first, rig.Time.GetUtcNow()).Should().BeTrue();
        rig.Connections.TryGet("pc-casa", out _).Should().BeFalse("sem sessão não há como entregar comando");
        rig.Time.Advance(TimeSpan.FromSeconds(4));

        rig.Connected.Should().BeTrue("o PC segue contando como conectado durante a graça");
        rig.Presence.Get("pc-casa")!.AgentVersion.Should().Be("1.0.0", "o que se sabia do agente fica");
        rig.Presence.OfflineSince("pc-casa").Should().BeNull();
        stream.Reader.TryRead(out _).Should().BeFalse("nenhuma queda é anunciada");

        // Volta dentro da graça: a espera acaba e o agente segue conectado muito depois do prazo antigo.
        rig.Connections.Attach(new StubSession("pc-casa"), Start.AddSeconds(9));
        rig.Time.Advance(Grace * 3);
        rig.Connected.Should().BeTrue();
        rig.Connections.IsInGrace("pc-casa").Should().BeFalse();
        var seen = new List<bool>();
        while (stream.Reader.TryRead(out var message))
        {
            seen.Add(message.Data.Agents[0].Connected);
        }

        seen.Should().Equal(true);
    }

    [Fact]
    public void ADropThatOutlastsTheGrace_IsAnnouncedOnce_WithTheInstantTheConnectionFell()
    {
        var rig = new Rig();
        var session = new StubSession("pc-casa");
        rig.Connections.Attach(session, Start);
        using var stream = rig.Events.Subscribe("dono");

        rig.Time.Advance(TimeSpan.FromSeconds(2));
        rig.Connections.Detach(session, rig.Time.GetUtcNow());
        rig.Time.Advance(Grace - TimeSpan.FromSeconds(1));
        rig.Connected.Should().BeTrue("falta um segundo para a graça acabar");
        stream.Reader.TryRead(out _).Should().BeFalse();

        rig.Time.Advance(TimeSpan.FromSeconds(2));

        rig.Connected.Should().BeFalse();
        rig.Presence.Get("pc-casa")!.DisconnectedAt.Should().Be(Start.AddSeconds(2), "a queda vale desde que a conexão caiu");
        stream.Reader.TryRead(out var message).Should().BeTrue();
        message!.Data.Agents[0].Connected.Should().BeFalse();
        stream.Reader.TryRead(out _).Should().BeFalse("um aviso só");
        rig.Connections.IsInGrace("pc-casa").Should().BeFalse();
    }

    [Fact]
    public void AReplacedSession_LeavingInsideTheGrace_DoesNotOpenAnotherGrace()
    {
        var rig = new Rig();
        var first = new StubSession("pc-casa");
        var second = new StubSession("pc-casa");
        rig.Connections.Attach(first, Start);
        rig.Connections.Attach(second, Start);

        rig.Connections.Detach(first, Start.AddSeconds(1)).Should().BeFalse();
        rig.Connections.IsInGrace("pc-casa").Should().BeFalse("a sessão nova é a dona: nada a esperar");
        rig.Time.Advance(Grace * 2);

        rig.Connected.Should().BeTrue();
    }

    [Fact]
    public async Task ARevokedAgent_LeavesTheGraceAtOnce()
    {
        var rig = new Rig();
        var session = new StubSession("pc-casa");
        rig.Connections.Attach(session, Start);
        using var stream = rig.Events.Subscribe("dono");

        await rig.Connections.CloseAsync("pc-casa", AgentCloseReason.Revoked, CancellationToken.None);
        rig.Connections.Detach(session, Start.AddSeconds(1));

        rig.Connected.Should().BeFalse("revogado não volta: a queda vale na hora");
        stream.Reader.TryRead(out var message).Should().BeTrue();
        message!.Data.Agents[0].Connected.Should().BeFalse();
    }

    [Fact]
    public async Task AnAgentRevokedWhileInTheGrace_IsDroppedAtOnce()
    {
        var rig = new Rig();
        var session = new StubSession("pc-casa");
        rig.Connections.Attach(session, Start);
        rig.Connections.Detach(session, Start.AddSeconds(1));
        rig.Connected.Should().BeTrue();

        await rig.Connections.CloseAsync("pc-casa", AgentCloseReason.Revoked, CancellationToken.None);

        rig.Connected.Should().BeFalse();
    }

    [Fact]
    public async Task ARevokedAgent_CannotBeReseededFromAnOldPresenceSnapshot()
    {
        var rig = new Rig();
        rig.Connections.ExpectReturn("pc-casa", Start.AddSeconds(-1), "1.2.3");

        await rig.Connections.CloseAsync("pc-casa", AgentCloseReason.Revoked, CancellationToken.None);
        rig.Connections.ExpectReturn("pc-casa", Start, "1.2.3");

        rig.Connected.Should().BeFalse();
        rig.Connections.IsInGrace("pc-casa").Should().BeFalse();
    }

    [Fact]
    public async Task ATimedOutWaiter_DoesNotRemoveAnotherCommandWaitingForTheSameAgent()
    {
        var rig = new Rig();
        var first = rig.Connections.WaitForSessionAsync("pc-casa", TimeSpan.FromSeconds(2), rig.Time, CancellationToken.None);
        var second = rig.Connections.WaitForSessionAsync("pc-casa", TimeSpan.FromSeconds(6), rig.Time, CancellationToken.None);

        rig.Time.Advance(TimeSpan.FromSeconds(3));
        (await first).Should().BeNull();
        var session = new StubSession("pc-casa");
        rig.Connections.Attach(session, rig.Time.GetUtcNow());

        (await second).Should().BeSameAs(session);
    }

    [Fact]
    public async Task AFailedRevocationClose_DropsTheSessionAndRejectsARacingHandshake()
    {
        var rig = new Rig();
        var session = new ThrowingSession("pc-casa");
        rig.Connections.Attach(session, Start);

        await rig.Connections.CloseAsync("pc-casa", AgentCloseReason.Revoked, CancellationToken.None);

        rig.Connected.Should().BeFalse();
        rig.Connections.TryGet("pc-casa", out _).Should().BeFalse();
        rig.Connections.Invoking(c => c.Attach(new StubSession("pc-casa"), Start.AddSeconds(1)))
            .Should().Throw<AgentSessionRevokedException>();
    }

    [Fact]
    public async Task ARevocationInProgress_RejectsAConcurrentHandshake()
    {
        var rig = new Rig();
        var first = new DelayedCloseSession("pc-casa");
        rig.Connections.Attach(first, Start);
        var closing = rig.Connections.CloseAsync("pc-casa", AgentCloseReason.Revoked, CancellationToken.None);
        rig.Connections.TryGet("pc-casa", out _).Should().BeFalse();
        rig.Connections.IsCurrent(first).Should().BeFalse();
        rig.Connections.Invoking(c => c.Attach(new StubSession("pc-casa"), Start.AddSeconds(1)))
            .Should().Throw<AgentSessionRevokedException>();

        first.FinishClose();
        await closing;
        rig.Connections.Detach(first, Start.AddSeconds(2)).Should().BeTrue();
        rig.Connected.Should().BeFalse();
    }

    private sealed class ThrowingSession(string agentId) : IAgentSession
    {
        public string AgentId { get; } = agentId;

        public ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken) => ValueTask.FromResult<byte[]?>(null);

        public ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken) => ValueTask.FromResult(true);

        public Task CloseAsync(AgentCloseReason reason, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("falha simulada no fechamento");

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class DelayedCloseSession(string agentId) : IAgentSession
    {
        private readonly TaskCompletionSource _close = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public string AgentId { get; } = agentId;

        public ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken) => ValueTask.FromResult<byte[]?>(null);

        public ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken) => ValueTask.FromResult(true);

        public Task CloseAsync(AgentCloseReason reason, CancellationToken cancellationToken) => _close.Task;

        public void FinishClose() => _close.TrySetResult();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    [Fact]
    public void ZeroGrace_KeepsTheOldBehavior_TheDropShowsAtOnce()
    {
        var rig = new Rig(graceSeconds: 0);
        var session = new StubSession("pc-casa");
        rig.Connections.Attach(session, Start);

        rig.Connections.Detach(session, Start.AddSeconds(3));

        rig.Connected.Should().BeFalse();
        rig.Presence.Get("pc-casa")!.DisconnectedAt.Should().Be(Start.AddSeconds(3));
    }

    [Fact]
    public void ExpectReturn_ForAnAgentSeenJustBeforeTheDeploy_CountsAsConnected_UntilTheGraceFromTheLastSignal()
    {
        var rig = new Rig();
        var lastSeen = Start.AddSeconds(-2);

        rig.Connections.ExpectReturn("pc-casa", lastSeen, "1.2.3");

        rig.Connected.Should().BeTrue("a API recém-subida não pode mostrar fora do ar quem acabou de ser visto");
        rig.Presence.Get("pc-casa")!.AgentVersion.Should().Be("1.2.3");

        rig.Time.Advance(Grace - TimeSpan.FromSeconds(2) + TimeSpan.FromSeconds(1));

        rig.Connected.Should().BeFalse("não reconectou dentro da graça contada desde o último sinal");
        rig.Presence.Get("pc-casa")!.DisconnectedAt.Should().Be(lastSeen);
    }

    [Fact]
    public void ExpectReturn_ForAnAgentSeenLongAgo_DoesNothing()
    {
        var rig = new Rig();

        rig.Connections.ExpectReturn("pc-casa", Start - Grace - TimeSpan.FromSeconds(1), "1.2.3");

        rig.Presence.Get("pc-casa").Should().BeNull();
    }

    [Fact]
    public void ExpectReturn_WhenTheAgentReconnectsHere_HandsOverToTheRealPresence()
    {
        var rig = new Rig();
        rig.Connections.ExpectReturn("pc-casa", Start.AddSeconds(-2), null);

        rig.Connections.Attach(new StubSession("pc-casa"), Start.AddSeconds(4));
        rig.Time.Advance(Grace * 2);

        rig.Connected.Should().BeTrue("a conexão real não some com o fim da graça");
        rig.Presence.Get("pc-casa")!.ConnectedSince.Should().Be(Start.AddSeconds(4));
    }

    [Fact]
    public void ExpectReturn_WhenThereIsASessionHere_ChangesNothing()
    {
        var rig = new Rig();
        var session = new StubSession("pc-casa");
        rig.Connections.Attach(session, Start);
        using var stream = rig.Events.Subscribe("dono");

        rig.Connections.ExpectReturn("pc-casa", Start, "9.9.9");

        stream.Reader.TryRead(out _).Should().BeFalse();
        rig.Presence.Get("pc-casa")!.ConnectedSince.Should().Be(Start);
    }

    [Fact]
    public void ExpectReturn_WithAFresherSignal_ExtendsTheWait_ButNeverShortensIt()
    {
        var rig = new Rig();
        rig.Connections.ExpectReturn("pc-casa", Start.AddSeconds(-3), null);

        // A instância anterior ainda atendia e renovou o resumo: a espera vai até o novo sinal mais a graça.
        rig.Time.Advance(TimeSpan.FromSeconds(2));
        rig.Connections.ExpectReturn("pc-casa", Start.AddSeconds(1), null);
        rig.Connections.ExpectReturn("pc-casa", Start.AddSeconds(-3), null);
        rig.Time.Advance(TimeSpan.FromSeconds(4));
        rig.Connected.Should().BeTrue("o primeiro prazo (5 s depois do início) já passou, o novo não");

        rig.Time.Advance(Grace);
        rig.Connected.Should().BeFalse();
    }

    [Fact]
    public void TheDefaultOptions_StayGreenLongAndLetACommandWaitForTheReconnection()
    {
        var options = new DevicesTransportOptions();

        // Verde por 150 s (cobre as quedas de deploy medidas); um comando enviado nesse intervalo espera 25 s pela volta.
        options.PresenceGrace.Should().Be(TimeSpan.FromSeconds(150));
        options.ReconnectGrace.Should().Be(TimeSpan.FromSeconds(25));
        DevicesTransportOptions.IsValid(options).Should().BeTrue();
        DevicesTransportOptions.IsValid(new DevicesTransportOptions { PresenceGraceSeconds = -1 }).Should().BeFalse();
        DevicesTransportOptions.IsValid(new DevicesTransportOptions { PresenceGraceSeconds = 0 }).Should().BeTrue();
        DevicesTransportOptions.IsValid(new DevicesTransportOptions { PresenceGraceSeconds = 3601 }).Should().BeFalse();
    }

    [Fact]
    public void AnAgentSeenLongBeforeTheApiStarted_IsRememberedAsOfflineSinceThen_WithoutAnyAnnouncement()
    {
        var rig = new Rig();
        using var stream = rig.Events.Subscribe("dono");

        rig.Connections.NoteLastSeen("pc-casa", Start.AddHours(-17), "0.4.1");

        var info = rig.Presence.Get("pc-casa")!;
        info.Connected.Should().BeFalse();
        info.DisconnectedAt.Should().Be(Start.AddHours(-17));
        stream.Reader.TryRead(out _).Should().BeFalse();

        // Se ele conectou antes, a lembrança não o derruba.
        rig.Connections.Attach(new StubSession("pc-casa"), Start);
        rig.Connections.NoteLastSeen("pc-casa", Start.AddHours(-17), "0.4.1");
        rig.Connected.Should().BeTrue();
    }
}
