using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Adapters;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.Presence;
using UniOver.Modules.Devices.Ports;

namespace UniOver.Modules.Devices.Tests.Transport;

internal sealed class StubSession(string agentId) : IAgentSession
{
    public string AgentId { get; } = agentId;

    public ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken) => ValueTask.FromResult<byte[]?>(null);

    public ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken) => ValueTask.FromResult(true);

    public Task CloseAsync(AgentCloseReason reason, CancellationToken cancellationToken) => Task.CompletedTask;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

public sealed class ReplyCorrelatorTests
{
    private static AgentReply Reply(Guid id) => new(id, true, null);

    [Fact]
    public async Task Reply_FromTheAgentThatReceivedTheCommand_CompletesTheWait()
    {
        var correlator = new ReplyCorrelator();
        var id = Guid.CreateVersion7();
        using var pending = correlator.Expect("pc-casa", id);

        correlator.TryComplete("pc-casa", id, Reply(id)).Should().BeTrue();

        (await pending.Reply).CorrelationId.Should().Be(id);
    }

    [Fact]
    public void Reply_FromAnotherAgent_LateOrRepeated_IsNotAccepted()
    {
        var correlator = new ReplyCorrelator();
        var id = Guid.CreateVersion7();
        var pending = correlator.Expect("pc-casa", id);

        correlator.TryComplete("outro", id, Reply(id)).Should().BeFalse("só o agente do comando responde por ele");
        correlator.TryComplete("pc-casa", Guid.CreateVersion7(), Reply(id)).Should().BeFalse("ninguém espera esse id");
        correlator.TryComplete("pc-casa", id, Reply(id)).Should().BeTrue();
        correlator.TryComplete("pc-casa", id, Reply(id)).Should().BeFalse("a segunda resposta é repetida");

        pending.Dispose();
        correlator.TryComplete("pc-casa", id, Reply(id)).Should().BeFalse();
    }

    [Fact]
    public void Disposing_RemovesTheWait()
    {
        var correlator = new ReplyCorrelator();
        var id = Guid.CreateVersion7();
        correlator.Expect("pc-casa", id).Dispose();

        correlator.TryComplete("pc-casa", id, Reply(id)).Should().BeFalse("a espera expirou e foi descartada (resposta tardia)");
    }

    [Fact]
    public async Task FailAll_FailsOnlyTheWaitsOfThatAgent()
    {
        var correlator = new ReplyCorrelator();
        var mine = correlator.Expect("pc-casa", Guid.CreateVersion7());
        var theirs = correlator.Expect("outro", Guid.CreateVersion7());

        correlator.FailAll("pc-casa");

        await mine.Invoking(p => p.Reply).Should().ThrowAsync<AgentDisconnectedException>();
        theirs.Reply.IsCompleted.Should().BeFalse();
    }
}

public sealed class PresenceStoreTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ConnectHelloAndDisconnect_FollowTheLifeOfTheAgent()
    {
        var store = new InMemoryPresenceStore();

        store.Get("pc-casa").Should().BeNull();
        store.MarkConnected("pc-casa", Now).Connected.Should().BeTrue();
        store.RecordHello("pc-casa", "1.0.0", ["tv.remote"], Now.AddSeconds(1));
        store.Touch("pc-casa", Now.AddSeconds(5));

        var info = store.Get("pc-casa")!;
        info.AgentVersion.Should().Be("1.0.0");
        info.Capabilities.Should().Equal("tv.remote");
        info.LastMessageAt.Should().Be(Now.AddSeconds(5));

        store.MarkDisconnected("pc-casa")!.Connected.Should().BeFalse();
        store.Get("pc-casa")!.AgentVersion.Should().Be("1.0.0", "o que se sabia do agente fica");
        store.All().Should().ContainSingle();
    }

    [Fact]
    public void Hello_OfADisconnectedAgent_IsIgnored_AndANewConnectionForgetsTheOldVersion()
    {
        var store = new InMemoryPresenceStore();
        store.RecordHello("pc-casa", "1.0.0", [], Now).Should().BeNull();

        store.MarkConnected("pc-casa", Now);
        store.RecordHello("pc-casa", "1.0.0", ["tv.adb"], Now);
        store.MarkConnected("pc-casa", Now.AddMinutes(1));

        var info = store.Get("pc-casa")!;
        info.AgentVersion.Should().BeNull();
        info.Capabilities.Should().BeEmpty();
    }
}

public sealed class AgentConnectionsTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private static (AgentConnections Connections, InMemoryPresenceStore Presence, SseBroadcaster<PresenceUpdate> Events) Create()
    {
        var presence = new InMemoryPresenceStore();
        var events = new SseBroadcaster<PresenceUpdate>(new SseStreamOptions());
        return (new AgentConnections(presence, events), presence, events);
    }

    [Fact]
    public void ReplacedSession_LeavingLater_DoesNotMarkTheAgentOffline()
    {
        var (connections, presence, events) = Create();
        using var stream = events.Subscribe("dono");
        var first = new StubSession("pc-casa");
        var second = new StubSession("pc-casa");

        connections.Attach(first, Now).Should().BeNull();
        connections.Attach(second, Now).Should().BeSameAs(first);
        connections.Detach(first).Should().BeFalse("a antiga já não é a dona da conexão");

        presence.Get("pc-casa")!.Connected.Should().BeTrue();
        connections.TryGet("pc-casa", out var current).Should().BeTrue();
        current.Should().BeSameAs(second);

        // Só duas notificações, as duas de "conectado": nenhuma queda falsa.
        var seen = new List<bool>();
        while (stream.Reader.TryRead(out var message))
        {
            seen.Add(message.Data.Agents[0].Connected);
        }

        seen.Should().Equal(true, true);

        connections.Detach(second).Should().BeTrue();
        presence.Get("pc-casa")!.Connected.Should().BeFalse();
    }

    [Fact]
    public void Touch_DoesNotNotifyAnyone_ButHelloDoes()
    {
        var (connections, _, events) = Create();
        var session = new StubSession("pc-casa");
        connections.Attach(session, Now);
        using var stream = events.Subscribe("dono");

        connections.Touch(session, Now.AddSeconds(1));
        stream.Reader.TryRead(out _).Should().BeFalse();

        connections.RecordHello(session, "2.0.0", [], Now.AddSeconds(2));
        stream.Reader.TryRead(out var message).Should().BeTrue();
        message!.Data.Agents[0].AgentVersion.Should().Be("2.0.0");
    }
}

public sealed class SseBroadcasterTests
{
    private static SseMessage<int> Message(int value) => new("teste", value);

    [Fact]
    public void Snapshot_ComesBeforeAnyLiveEvent()
    {
        var broadcaster = new SseBroadcaster<int>(new SseStreamOptions());

        using var stream = broadcaster.Subscribe("dono", () => [Message(1), Message(2)]);
        broadcaster.Publish(Message(3));

        var received = new List<int>();
        while (stream.Reader.TryRead(out var message))
        {
            received.Add(message.Data);
        }

        received.Should().Equal(1, 2, 3);
    }

    [Fact]
    public void FourthStreamOfAUser_ClosesTheOldest_AndOtherUsersAreUntouched()
    {
        var broadcaster = new SseBroadcaster<int>(new SseStreamOptions { MaxStreamsPerUser = 3 });
        var streams = Enumerable.Range(0, 3).Select(_ => broadcaster.Subscribe("dono")).ToList();
        using var outsider = broadcaster.Subscribe("outro");

        var fourth = broadcaster.Subscribe("dono");

        streams[0].Reader.Completion.IsCompleted.Should().BeTrue("o mais antigo foi fechado");
        streams[1].Reader.Completion.IsCompleted.Should().BeFalse();
        streams[2].Reader.Completion.IsCompleted.Should().BeFalse();
        fourth.Reader.Completion.IsCompleted.Should().BeFalse();
        outsider.Reader.Completion.IsCompleted.Should().BeFalse();
        broadcaster.SubscriberCount.Should().Be(4);
    }

    [Fact]
    public void SubscriberThatDoesNotKeepUp_IsClosedInsteadOfHoldingMemory()
    {
        var broadcaster = new SseBroadcaster<int>(new SseStreamOptions { SubscriberQueue = 2 });
        using var slow = broadcaster.Subscribe("dono");

        broadcaster.Publish(Message(1));
        broadcaster.Publish(Message(2));
        slow.Reader.Completion.IsCompleted.Should().BeFalse();
        broadcaster.Publish(Message(3));

        broadcaster.SubscriberCount.Should().Be(0);
        while (slow.Reader.TryRead(out _))
        {
        }

        slow.Reader.Completion.IsCompleted.Should().BeTrue("fechado: quem lê termina depois de esvaziar a fila");
    }

    [Theory]
    [InlineData("com\nquebra")]
    [InlineData("")]
    [InlineData("com espaço")]
    public void EventNameThatCouldInjectFields_IsRefused(string name)
    {
        var broadcaster = new SseBroadcaster<int>(new SseStreamOptions());

        broadcaster.Invoking(b => b.Publish(new SseMessage<int>(name, 1))).Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Defaults_AreTheApprovedOnes()
    {
        var options = new SseStreamOptions();

        options.MaxStreamsPerUser.Should().Be(3);
        options.KeepAlive.Should().Be(TimeSpan.FromSeconds(15));
        options.MaxLifetime.Should().Be(TimeSpan.FromMinutes(10));
    }
}

public sealed class ProtocolDirectionTests
{
    [Fact]
    public void EveryKnownMessageType_HasExactlyOneDirection()
    {
        foreach (var type in AgentMessageTypes.All)
        {
            var directions = (AgentMessageDirections.FromAgent.Contains(type) ? 1 : 0)
                + (AgentMessageDirections.ToAgent.Contains(type) ? 1 : 0);
            directions.Should().Be(1, $"o tipo {type} precisa estar numa lista de direção, e só numa");
        }
    }

    [Fact]
    public void TransportOptions_Defaults_AreValid_AndZeroLimitsAreNot()
    {
        DevicesTransportOptions.IsValid(new DevicesTransportOptions()).Should().BeTrue();
        DevicesTransportOptions.IsValid(new DevicesTransportOptions { QueueCapacity = 0 }).Should().BeFalse();
        DevicesTransportOptions.IsValid(new DevicesTransportOptions { MaxMessageBytes = 10 }).Should().BeFalse();
        DevicesTransportOptions.IsValid(new DevicesTransportOptions { Sse = new SseStreamOptions { MaxStreamsPerUser = 0 } }).Should().BeFalse();
    }
}
