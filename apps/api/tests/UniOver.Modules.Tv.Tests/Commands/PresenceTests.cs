using System.Text.Json;
using AwesomeAssertions;
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

        throttle.TryPass("pc-casa").Should().BeTrue();
        time.Advance(TimeSpan.FromSeconds(9));
        throttle.TryPass("pc-casa").Should().BeFalse("antes de 10 s o agente já recebeu um sinal");
        time.Advance(TimeSpan.FromSeconds(1));
        throttle.TryPass("pc-casa").Should().BeTrue();
    }

    [Fact]
    public void Throttle_CountsEachAgentApart()
    {
        var throttle = new PresenceThrottle(new ManualTime());

        throttle.TryPass("pc-casa").Should().BeTrue();
        throttle.TryPass("pc-raphael").Should().BeTrue();
        throttle.TryPass("pc-casa").Should().BeFalse();
    }

    [Fact]
    public void Throttle_UnderConcurrency_LetsExactlyOneThrough()
    {
        var throttle = new PresenceThrottle(new ManualTime());
        var passed = 0;

        Parallel.For(0, 200, _ =>
        {
            if (throttle.TryPass("pc-casa"))
            {
                Interlocked.Increment(ref passed);
            }
        });

        passed.Should().Be(1);
    }
}
