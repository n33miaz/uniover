using AwesomeAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Tests.Adapters;

public class TvAgentResolverTests
{
    private sealed class ManualTime : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan by) => _now += by;
    }

    private sealed class FakeReader : ISavedTvReader
    {
        public SavedTv? Saved { get; set; }

        public bool Fails { get; set; }

        public int Reads { get; private set; }

        /// <summary>Quando definida, a leitura espera por ela (para provar o que acontece com uma leitura lenta).</summary>
        public TaskCompletionSource? Gate { get; set; }

        public async Task<SavedTv?> ReadDefaultAsync(CancellationToken cancellationToken)
        {
            Reads++;
            var snapshot = Saved;
            if (Gate is { } gate)
            {
                await gate.Task.WaitAsync(cancellationToken);
            }

            cancellationToken.ThrowIfCancellationRequested();
            return Fails ? throw new InvalidOperationException("banco fora do ar") : snapshot;
        }
    }

    private static (TvAgentResolver Resolver, FakeReader Reader, ManualTime Time) Build(string environment = "")
    {
        var reader = new FakeReader();
        var time = new ManualTime();
        var options = Options.Create(new TvModuleOptions { AgentId = environment });
        return (new TvAgentResolver(reader, options, time, NullLogger<TvAgentResolver>.Instance), reader, time);
    }

    [Fact]
    public async Task SavedRow_WinsOverTheEnvironmentValue()
    {
        var (resolver, reader, _) = Build(environment: "pc-antigo");
        reader.Saved = new SavedTv("pc-novo", "TV da sala");

        var binding = await resolver.ResolveAsync(CancellationToken.None);

        binding.AgentSlug.Should().Be("pc-novo");
        binding.Name.Should().Be("TV da sala");
        binding.Source.Should().Be(TvAgentSource.Saved);
        binding.IsConfigured.Should().BeTrue();
    }

    [Fact]
    public async Task WithoutARow_TheEnvironmentValueStillWorks()
    {
        var (resolver, _, _) = Build(environment: "pc-casa");

        var binding = await resolver.ResolveAsync(CancellationToken.None);

        binding.AgentSlug.Should().Be("pc-casa");
        binding.Source.Should().Be(TvAgentSource.Environment);
        binding.IsConfigured.Should().BeTrue();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task WithoutARowAndWithoutTheEnvironmentValue_NothingIsConfigured(string environment)
    {
        var (resolver, _, _) = Build(environment);

        var binding = await resolver.ResolveAsync(CancellationToken.None);

        binding.AgentSlug.Should().BeNull();
        binding.Source.Should().Be(TvAgentSource.None);
        binding.IsConfigured.Should().BeFalse();
    }

    [Fact]
    public async Task TheValueIsCached_UntilItsLifetimeEnds()
    {
        var (resolver, reader, time) = Build();
        reader.Saved = new SavedTv("pc-a", "TV");

        await resolver.ResolveAsync(CancellationToken.None);
        reader.Saved = new SavedTv("pc-b", "TV");
        var cached = await resolver.ResolveAsync(CancellationToken.None);
        time.Advance(TvAgentResolver.Lifetime - TimeSpan.FromSeconds(1));
        var almost = await resolver.ResolveAsync(CancellationToken.None);
        time.Advance(TimeSpan.FromSeconds(2));
        var expired = await resolver.ResolveAsync(CancellationToken.None);

        cached.AgentSlug.Should().Be("pc-a");
        almost.AgentSlug.Should().Be("pc-a");
        expired.AgentSlug.Should().Be("pc-b");
        reader.Reads.Should().Be(2, "a primeira leitura e a depois do prazo");
    }

    [Fact]
    public async Task ACachedValue_IsReturnedWithoutWaiting()
    {
        var (resolver, reader, _) = Build();
        reader.Saved = new SavedTv("pc-a", "TV");
        await resolver.ResolveAsync(CancellationToken.None);

        var pending = resolver.ResolveAsync(CancellationToken.None);

        pending.IsCompletedSuccessfully.Should().BeTrue("quem roda dentro da conexão do agente não pode esperar");
    }

    [Fact]
    public async Task Set_ReplacesTheValueAtOnce_AndAnOlderReadInFlightDoesNotOverwriteIt()
    {
        var (resolver, reader, _) = Build();
        reader.Saved = new SavedTv("pc-velho", "TV");
        reader.Gate = new TaskCompletionSource();
        var slowRead = resolver.ResolveAsync(CancellationToken.None).AsTask();

        resolver.Set(new TvAgentBinding("pc-novo", "TV", TvAgentSource.Saved));
        reader.Gate.SetResult();
        await slowRead;

        (await resolver.ResolveAsync(CancellationToken.None)).AgentSlug.Should().Be("pc-novo");
        resolver.TryGetLast(out var last).Should().BeTrue();
        last!.AgentSlug.Should().Be("pc-novo");
    }

    [Fact]
    public async Task Invalidate_MakesTheNextAskReadTheDatabaseAgain()
    {
        var (resolver, reader, _) = Build();
        reader.Saved = new SavedTv("pc-a", "TV");
        await resolver.ResolveAsync(CancellationToken.None);
        reader.Saved = new SavedTv("pc-b", "TV");

        resolver.Invalidate();
        resolver.TryGetLast(out _).Should().BeFalse("sem valor conhecido até a próxima leitura");

        (await resolver.ResolveAsync(CancellationToken.None)).AgentSlug.Should().Be("pc-b");
    }

    [Fact]
    public async Task TryGetLast_IsFalseBeforeTheFirstRead_AndNeverTouchesTheDatabase()
    {
        var (resolver, reader, _) = Build();

        resolver.TryGetLast(out var before).Should().BeFalse();
        before.Should().BeNull();
        reader.Reads.Should().Be(0);

        await resolver.ResolveAsync(CancellationToken.None);
        resolver.TryGetLast(out var after).Should().BeTrue();
        after.Should().NotBeNull();
    }

    [Fact]
    public async Task TryGetLast_StillAnswersWithAnExpiredValue()
    {
        var (resolver, reader, time) = Build();
        reader.Saved = new SavedTv("pc-a", "TV");
        await resolver.ResolveAsync(CancellationToken.None);

        time.Advance(TvAgentResolver.Lifetime + TimeSpan.FromMinutes(5));

        resolver.TryGetLast(out var last).Should().BeTrue();
        last!.AgentSlug.Should().Be("pc-a");
        reader.Reads.Should().Be(1);
    }

    [Fact]
    public async Task WhenTheDatabaseFailsAndNothingWasKnown_ItFallsBackToTheEnvironmentValue_AndRetriesSoon()
    {
        var (resolver, reader, time) = Build(environment: "pc-casa");
        reader.Fails = true;

        var first = await resolver.ResolveAsync(CancellationToken.None);
        var second = await resolver.ResolveAsync(CancellationToken.None);
        reader.Fails = false;
        reader.Saved = new SavedTv("pc-novo", "TV");
        time.Advance(TvAgentResolver.RetryAfterFailure + TimeSpan.FromSeconds(1));
        var afterRetry = await resolver.ResolveAsync(CancellationToken.None);

        first.Source.Should().Be(TvAgentSource.Environment);
        second.Source.Should().Be(TvAgentSource.Environment);
        reader.Reads.Should().Be(2, "a segunda pergunta usou o valor de reserva; a terceira, depois do prazo curto, leu de novo");
        afterRetry.AgentSlug.Should().Be("pc-novo");
    }

    [Fact]
    public async Task WhenTheDatabaseFailsAfterAValueWasKnown_TheLastKnownValueKeepsWorking()
    {
        var (resolver, reader, time) = Build(environment: "pc-casa");
        reader.Saved = new SavedTv("pc-salvo", "TV");
        await resolver.ResolveAsync(CancellationToken.None);

        reader.Fails = true;
        time.Advance(TvAgentResolver.Lifetime + TimeSpan.FromSeconds(1));
        var binding = await resolver.ResolveAsync(CancellationToken.None);

        binding.AgentSlug.Should().Be("pc-salvo", "a TV não volta para a variável só porque o banco ficou fora do ar");
        binding.Source.Should().Be(TvAgentSource.Saved);
    }

    [Fact]
    public async Task ManyCallersAtTheSameTime_ShareASingleRead()
    {
        var (resolver, reader, _) = Build();
        reader.Saved = new SavedTv("pc-a", "TV");
        reader.Gate = new TaskCompletionSource();

        var calls = Enumerable.Range(0, 5).Select(_ => resolver.ResolveAsync(CancellationToken.None).AsTask()).ToArray();
        reader.Gate.SetResult();
        var results = await Task.WhenAll(calls);

        results.Should().OnlyContain(b => b.AgentSlug == "pc-a");
        reader.Reads.Should().Be(1);
    }

    [Fact]
    public async Task ACancelledRead_IsNotSwallowedAsADatabaseFailure()
    {
        var (resolver, reader, _) = Build(environment: "pc-casa");
        reader.Gate = new TaskCompletionSource();
        using var source = new CancellationTokenSource();

        var pending = resolver.ResolveAsync(source.Token).AsTask();
        await source.CancelAsync();

        await FluentActions.Awaiting(() => pending).Should().ThrowAsync<OperationCanceledException>();
        resolver.TryGetLast(out _).Should().BeFalse("o cancelamento não deixa um valor falso no cache");
    }
}
