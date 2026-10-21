using System.Diagnostics.CodeAnalysis;
using AwesomeAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Tests.Adapters;

public class TvPresenceListenerTests
{
    private sealed class Resolver(TvAgentBinding? last, TaskCompletionSource<TvAgentBinding>? slowRead = null) : ITvAgentResolver
    {
        public int Reads { get; private set; }

        public ValueTask<TvAgentBinding> ResolveAsync(CancellationToken cancellationToken)
        {
            Reads++;
            return slowRead is null ? ValueTask.FromResult(last!) : new ValueTask<TvAgentBinding>(slowRead.Task);
        }

        public bool TryGetLast([NotNullWhen(true)] out TvAgentBinding? binding)
        {
            binding = last;
            return binding is not null;
        }

        public void Set(TvAgentBinding binding)
        {
        }

        public void Invalidate()
        {
        }
    }

    private sealed class Stream : ITvStreamPublisher
    {
        public List<TvState> States { get; } = [];

        public void PublishState(TvState state) => States.Add(state);

        public void PublishShortcuts(IReadOnlyList<TvShortcut> shortcuts)
        {
        }

        public void PublishWatchdog(TvWatchdogEntry entry)
        {
        }
    }

    private static AgentPresenceInfo Presence(string agentId, bool connected) =>
        new(agentId, connected, connected ? DateTimeOffset.UtcNow : null, null, [], null);

    private static TvAgentBinding Saved(string slug) => new(slug, "TV", TvAgentSource.Saved);

    [Fact]
    public void WithAKnownValue_TheBoundAgentPresenceIsPublishedAtOnce_WithoutReading()
    {
        var resolver = new Resolver(Saved("pc-novo"));
        var stream = new Stream();
        var listener = new TvPresenceListener(resolver, new InMemoryTvStateStore(), stream, NullLogger<TvPresenceListener>.Instance);

        listener.OnPresenceChanged(Presence("pc-novo", connected: true));

        stream.States.Should().ContainSingle().Which.AgentOnline.Should().BeTrue();
        resolver.Reads.Should().Be(0, "quem roda dentro da conexão do agente não consulta o banco");
    }

    [Fact]
    public void AnotherAgent_IsIgnored_EvenIfItWasTheOldOne()
    {
        var stream = new Stream();
        var listener = new TvPresenceListener(
            new Resolver(Saved("pc-novo")), new InMemoryTvStateStore(), stream, NullLogger<TvPresenceListener>.Instance);

        listener.OnPresenceChanged(Presence("pc-antigo", connected: true));

        stream.States.Should().BeEmpty();
    }

    [Fact]
    public void WithNothingConfigured_NothingIsPublished()
    {
        var stream = new Stream();
        var listener = new TvPresenceListener(
            new Resolver(TvAgentBinding.NotConfigured), new InMemoryTvStateStore(), stream, NullLogger<TvPresenceListener>.Instance);

        listener.OnPresenceChanged(Presence("pc-casa", connected: true));

        stream.States.Should().BeEmpty();
    }

    [Fact]
    public async Task WithoutAKnownValueYet_TheDecisionWaitsForTheReadInTheBackground_AndIsNotLost()
    {
        var read = new TaskCompletionSource<TvAgentBinding>();
        var stream = new Stream();
        var listener = new TvPresenceListener(
            new Resolver(last: null, read), new InMemoryTvStateStore(), stream, NullLogger<TvPresenceListener>.Instance);

        listener.OnPresenceChanged(Presence("pc-novo", connected: true));
        stream.States.Should().BeEmpty("a conexão do agente não espera pela leitura");

        read.SetResult(Saved("pc-novo"));
        await WaitAsync(() => stream.States.Count == 1);

        stream.States.Single().AgentOnline.Should().BeTrue();
    }

    [Fact]
    public async Task WhenTheBackgroundReadFails_NothingBreaks()
    {
        var read = new TaskCompletionSource<TvAgentBinding>();
        var stream = new Stream();
        var listener = new TvPresenceListener(
            new Resolver(last: null, read), new InMemoryTvStateStore(), stream, NullLogger<TvPresenceListener>.Instance);

        listener.OnPresenceChanged(Presence("pc-novo", connected: true));
        read.SetException(new InvalidOperationException("banco fora do ar"));
        await Task.Delay(50, TestContext.Current.CancellationToken);

        stream.States.Should().BeEmpty();
    }

    private static async Task WaitAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException("A condição não foi atingida.");
            }

            await Task.Delay(10, TestContext.Current.CancellationToken);
        }
    }
}
