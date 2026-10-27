using AwesomeAssertions;
using UniOver.Modules.Identity.Features.SystemSettings;

namespace UniOver.Modules.Identity.Tests.SystemSettings;

public class SystemSettingsCacheTests
{
    private const string Key = "devices.max-per-guest";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class ManualTime : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 10, 27, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static SystemSettingsCache NewCache(ManualTime time) => new(time, TimeSpan.FromSeconds(15));

    [Fact]
    public async Task GetAsync_WithinTheLifetime_ReadsTheStoreOnce()
    {
        var time = new ManualTime();
        var cache = NewCache(time);
        var calls = 0;
        Task<string?> Load(CancellationToken _) { calls++; return Task.FromResult<string?>("3"); }

        (await cache.GetAsync(Key, Load, Ct)).Should().Be("3");
        time.Now = time.Now.AddSeconds(14);
        (await cache.GetAsync(Key, Load, Ct)).Should().Be("3");

        calls.Should().Be(1);
    }

    [Fact]
    public async Task GetAsync_AfterTheLifetime_ReadsTheStoreAgain()
    {
        var time = new ManualTime();
        var cache = NewCache(time);
        var calls = 0;
        Task<string?> Load(CancellationToken _) { calls++; return Task.FromResult<string?>("3"); }

        await cache.GetAsync(Key, Load, Ct);
        time.Now = time.Now.AddSeconds(16);
        await cache.GetAsync(Key, Load, Ct);

        calls.Should().Be(2);
    }

    [Fact]
    public async Task Invalidate_AfterAStoredValue_ForcesTheNextReadToTheStore()
    {
        var cache = NewCache(new ManualTime());
        await cache.GetAsync(Key, _ => Task.FromResult<string?>("2"), Ct);

        cache.Invalidate(Key);

        (await cache.GetAsync(Key, _ => Task.FromResult<string?>("5"), Ct)).Should().Be("5");
    }

    [Fact]
    public async Task GetAsync_StartedBeforeInvalidate_DoesNotPutTheStaleValueBack()
    {
        var cache = NewCache(new ManualTime());
        var readStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        // A leitura em voo já viu o valor velho no banco e está parada antes de devolvê-lo.
        var inFlight = cache.GetAsync(Key, async _ =>
        {
            readStarted.SetResult();
            await releaseRead.Task;
            return "2";
        }, Ct);
        await readStarted.Task;

        // A gravação acontece e invalida enquanto essa leitura ainda está em voo.
        cache.Invalidate(Key);
        releaseRead.SetResult();
        (await inFlight).Should().Be("2", "quem já estava lendo recebe o que leu, mas isso não pode ir para o cache");

        var calls = 0;
        var next = await cache.GetAsync(Key, _ => { calls++; return Task.FromResult<string?>("5"); }, Ct);

        next.Should().Be("5");
        calls.Should().Be(1);
    }

    [Fact]
    public async Task Invalidate_OfAnotherKey_DoesNotDiscardTheInFlightRead()
    {
        var cache = NewCache(new ManualTime());
        var readStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var inFlight = cache.GetAsync(Key, async _ =>
        {
            readStarted.SetResult();
            await releaseRead.Task;
            return "2";
        }, Ct);
        await readStarted.Task;

        cache.Invalidate("training.off-contact");
        releaseRead.SetResult();
        await inFlight;

        var calls = 0;
        (await cache.GetAsync(Key, _ => { calls++; return Task.FromResult<string?>("9"); }, Ct)).Should().Be("2");
        calls.Should().Be(0);
    }

    [Fact]
    public async Task GetAsync_WhenTheStoreThrows_CachesNothing()
    {
        var cache = NewCache(new ManualTime());

        var failing = () => cache.GetAsync(Key, _ => throw new InvalidOperationException("banco fora"), Ct);
        await failing.Should().ThrowAsync<InvalidOperationException>();

        (await cache.GetAsync(Key, _ => Task.FromResult<string?>("4"), Ct)).Should().Be("4");
    }
}
