using System.Text.Json;
using AwesomeAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;
using UniOver.Modules.Tv.Tests.Support;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Features.Presence;

namespace UniOver.Modules.Tv.Tests.Commands;

public class PresenceTests
{
    private sealed class ManualTime : TimeProvider
    {
        private long ticks = 1_000;

        public override long TimestampFrequency => 1_000;

        public override long GetTimestamp() => ticks;

        public void Advance(TimeSpan by) => ticks += (long)(by.TotalSeconds * TimestampFrequency);
    }

    [Fact]
    public void TheMessage_HasTheContractType_AndAnEmptyBody()
    {
        var message = TvMessages.Presence();

        message.Type.Should().Be("tv.presence.v1");
        message.Body.ValueKind.Should().Be(JsonValueKind.Object);
        message.Body.EnumerateObject().Should().BeEmpty();
    }

    [Fact]
    public void Throttle_PassesTheFirstSignal_ThenBlocksUntilTheIntervalPasses()
    {
        var time = new ManualTime();
        var throttle = new PresenceThrottle(time);

        throttle.TryPass("pc-casa").Should().NotBeNull();
        time.Advance(TimeSpan.FromSeconds(9));
        throttle.TryPass("pc-casa").Should().BeNull("antes de 10 s o agente já recebeu um sinal");
        time.Advance(TimeSpan.FromSeconds(1));
        throttle.TryPass("pc-casa").Should().NotBeNull();
    }

    [Fact]
    public void Throttle_CountsEachAgentApart()
    {
        var throttle = new PresenceThrottle(new ManualTime());

        throttle.TryPass("pc-casa").Should().NotBeNull();
        throttle.TryPass("pc-raphael").Should().NotBeNull();
        throttle.TryPass("pc-casa").Should().BeNull();
    }

    [Fact]
    public void Throttle_UnderConcurrency_LetsExactlyOneThrough()
    {
        var throttle = new PresenceThrottle(new ManualTime());
        var passed = 0;

        Parallel.For(0, 200, _ =>
        {
            if (throttle.TryPass("pc-casa") is not null)
            {
                Interlocked.Increment(ref passed);
            }
        });

        passed.Should().Be(1);
    }

    [Fact]
    public void Throttle_UndoGivesTheIntervalBack_SoAFailedDeliveryDoesNotCostTheNextSignal()
    {
        var throttle = new PresenceThrottle(new ManualTime());

        var ticket = throttle.TryPass("pc-casa");
        ticket.Should().NotBeNull();
        throttle.TryPass("pc-casa").Should().BeNull();
        throttle.Undo(ticket!.Value);

        throttle.TryPass("pc-casa").Should().NotBeNull("o sinal anterior nunca chegou ao agente");
    }

    [Fact]
    public void Throttle_UndoOfAnOlderReservationDoesNotEraseANewerOne()
    {
        var time = new ManualTime();
        var throttle = new PresenceThrottle(time);
        var first = throttle.TryPass("pc-casa")!.Value;
        time.Advance(TimeSpan.FromSeconds(11));
        throttle.TryPass("pc-casa").Should().NotBeNull(); // a reserva nova, depois do intervalo

        throttle.Undo(first); // o desfazer atrasado da primeira não pode apagar a segunda

        throttle.TryPass("pc-casa").Should().BeNull();
    }

    private sealed class Sender(TvSendOutcome outcome) : ITvCommandSender
    {
        public int Posts { get; private set; }

        public Task<TvSendOutcome> RequestAsync(string agentId, TvMessage message, TimeSpan timeout, CancellationToken cancellationToken) =>
            Task.FromResult(outcome);

        public Task<TvSendOutcome> PostAsync(string agentId, TvMessage message, CancellationToken cancellationToken)
        {
            Posts++;
            return Task.FromResult(outcome);
        }
    }

    private sealed class NoAudit : ITvCommandAudit
    {
        public Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class NoStream : ITvStreamPublisher
    {
        public void PublishState(TvState state)
        {
        }

        public void PublishShortcuts(IReadOnlyList<TvShortcut> shortcuts)
        {
        }

        public void PublishWatchdog(TvWatchdogEntry entry)
        {
        }
    }

    private sealed class Agents(params string[] capabilities) : IAgentPresenceReader
    {
        public TimeSpan ReconnectGrace => TimeSpan.FromSeconds(10);

        public AgentPresenceInfo? Get(string agentId) =>
            new(agentId, true, DateTimeOffset.UtcNow, "2.0.0", capabilities, DateTimeOffset.UtcNow);

        public IReadOnlyList<AgentPresenceInfo> All() => [];

        public DateTimeOffset? OfflineSince(string agentId) => null;
    }

    private static (PresenceHandler Handler, Sender Sender) BuildHandler(TvSendOutcome outcome)
    {
        var sender = new Sender(outcome);
        var runner = new TvCommandRunner(
            Options.Create(new TvModuleOptions { CommandTimeoutSeconds = 8, HibernatingTimeoutSeconds = 25 }),
            new FixedAgentResolver("pc-casa"),
            new FakePresence(),
            sender,
            new InMemoryTvStateStore(),
            new NoAudit(),
            new NoStream(),
            TimeProvider.System,
            NullLogger<TvCommandRunner>.Instance);
        return (new PresenceHandler(runner, new Agents("tv.presence.v1"), new PresenceThrottle(TimeProvider.System)), sender);
    }

    private static readonly TvCommandOrigin Origin = new(Guid.NewGuid(), new ClientInfo("203.0.113.1", "teste"));

    [Fact]
    public async Task Handler_ADeliveredSignalOccupiesTheInterval()
    {
        var (handler, sender) = BuildHandler(TvSendOutcome.Ok(TimeSpan.Zero));

        await handler.HandleAsync(Origin, CancellationToken.None);
        await handler.HandleAsync(Origin, CancellationToken.None);

        sender.Posts.Should().Be(1);
    }

    [Fact]
    public async Task Handler_AFailedDeliveryDoesNotOccupyTheInterval()
    {
        var (handler, sender) = BuildHandler(TvSendOutcome.Failed(TvSendStatus.AgentOffline, "agent_offline"));

        await handler.HandleAsync(Origin, CancellationToken.None);
        await handler.HandleAsync(Origin, CancellationToken.None);

        sender.Posts.Should().Be(2, "o primeiro nunca chegou ao agente, então o segundo tenta de novo");
    }
}
