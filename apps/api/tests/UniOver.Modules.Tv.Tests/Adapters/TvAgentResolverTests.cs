using AwesomeAssertions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Ports;
using UniOver.Modules.Tv.Tests.Support;

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

        /// <summary>O texto da exceção da falha: tem de ser algo que nunca pode aparecer no log.</summary>
        public string FailureMessage { get; set; } = "banco fora do ar";

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
            return Fails ? throw new InvalidOperationException(FailureMessage) : snapshot;
        }
    }

    private static (TvAgentResolver Resolver, FakeReader Reader, ManualTime Time) Build(
        ILogger<TvAgentResolver>? logger = null)
    {
        var reader = new FakeReader();
        var time = new ManualTime();
        return (new TvAgentResolver(reader, time, logger ?? NullLogger<TvAgentResolver>.Instance), reader, time);
    }
    [Fact]
    public async Task SavedRow_IsTheConfiguredTv()
    {
        var (resolver, reader, _) = Build();
        reader.Saved = new SavedTv("pc-novo", "TV da sala");

        var binding = await resolver.ResolveAsync(CancellationToken.None);

        binding.AgentSlug.Should().Be("pc-novo");
        binding.Name.Should().Be("TV da sala");
        binding.Source.Should().Be(TvAgentSource.Saved);
        binding.IsConfigured.Should().BeTrue();
    }

    [Fact]
    public async Task WithoutARow_NothingIsConfigured()
    {
        var (resolver, _, _) = Build();

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
    public async Task WhenTheDatabaseFailsAndNothingWasKnown_NothingIsConfigured_AndItRetriesSoon()
    {
        // Sem conseguir ler a linha salva e sem valor conhecido, ninguém é escolhido às cegas.
        var (resolver, reader, time) = Build();
        reader.Fails = true;

        var first = await resolver.ResolveAsync(CancellationToken.None);
        var second = await resolver.ResolveAsync(CancellationToken.None);
        reader.Fails = false;
        reader.Saved = new SavedTv("pc-novo", "TV");
        time.Advance(TvAgentResolver.RetryAfterFailure + TimeSpan.FromSeconds(1));
        var afterRetry = await resolver.ResolveAsync(CancellationToken.None);

        first.Source.Should().Be(TvAgentSource.None);
        first.IsConfigured.Should().BeFalse("os comandos respondem 503 em vez de ir a um computador qualquer");
        second.Source.Should().Be(TvAgentSource.None);
        reader.Reads.Should().Be(2, "a segunda pergunta usou o resultado curto da falha; a terceira, depois do prazo curto, leu de novo");
        afterRetry.AgentSlug.Should().Be("pc-novo");
        afterRetry.Source.Should().Be(TvAgentSource.Saved);
    }

    [Fact]
    public async Task WhenTheDatabaseFailsAfterAnEmptyRead_NothingStaysConfigured()
    {
        var (resolver, reader, time) = Build();
        (await resolver.ResolveAsync(CancellationToken.None)).Source.Should().Be(TvAgentSource.None);

        reader.Fails = true;
        time.Advance(TvAgentResolver.Lifetime + TimeSpan.FromSeconds(1));
        var binding = await resolver.ResolveAsync(CancellationToken.None);

        binding.IsConfigured.Should().BeFalse();
        binding.Source.Should().Be(TvAgentSource.None);
    }

    [Fact]
    public async Task WhenTheDatabaseFailsRightAfterInvalidate_NothingIsConfigured()
    {
        // Invalidate esquece o valor (não se sabe se o salvamento valeu): a falha seguinte não pode escolher um computador às cegas.
        var (resolver, reader, _) = Build();
        reader.Saved = new SavedTv("pc-novo", "TV");
        await resolver.ResolveAsync(CancellationToken.None);

        resolver.Invalidate();
        reader.Fails = true;
        var binding = await resolver.ResolveAsync(CancellationToken.None);

        binding.Source.Should().Be(TvAgentSource.None);
        binding.AgentSlug.Should().BeNull();
    }

    [Fact]
    public async Task AFailureWithNothingKnown_IsNotReportedAsAKnownValue()
    {
        var (resolver, reader, _) = Build();
        reader.Fails = true;
        await resolver.ResolveAsync(CancellationToken.None);

        resolver.TryGetLast(out var last).Should().BeFalse("o 'não configurado' de uma falha não é um valor lido do banco");
        last.Should().BeNull();
    }

    [Fact]
    public async Task AReadFailure_LogsOnlyTheErrorType_NeverTheExceptionOrItsMessage()
    {
        var logger = new CapturingLogger<TvAgentResolver>();
        var (resolver, reader, _) = Build(logger);
        reader.Fails = true;
        reader.FailureMessage = "Host=ep-segredo.neon.tech;Username=uniover_owner;Password=senha-do-banco";

        await resolver.ResolveAsync(CancellationToken.None);

        var line = logger.Lines.Should().ContainSingle().Subject;
        line.Exception.Should().BeNull("a exceção inteira carrega a mensagem do driver");
        line.Message.Should().Contain(nameof(InvalidOperationException));
        logger.Everything.Should().NotContain("ep-segredo").And.NotContain("senha-do-banco").And.NotContain("uniover_owner");
    }

    [Fact]
    public async Task WhenTheDatabaseFailsAfterAValueWasKnown_TheLastKnownValueKeepsWorking()
    {
        var (resolver, reader, time) = Build();
        reader.Saved = new SavedTv("pc-salvo", "TV");
        await resolver.ResolveAsync(CancellationToken.None);

        reader.Fails = true;
        time.Advance(TvAgentResolver.Lifetime + TimeSpan.FromSeconds(1));
        var binding = await resolver.ResolveAsync(CancellationToken.None);

        binding.AgentSlug.Should().Be("pc-salvo", "o banco fora do ar não derruba a TV que já se conhece");
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
        var (resolver, reader, _) = Build();
        reader.Gate = new TaskCompletionSource();
        using var source = new CancellationTokenSource();

        var pending = resolver.ResolveAsync(source.Token).AsTask();
        await source.CancelAsync();

        await FluentActions.Awaiting(() => pending).Should().ThrowAsync<OperationCanceledException>();
        resolver.TryGetLast(out _).Should().BeFalse("o cancelamento não deixa um valor falso no cache");
    }
}
