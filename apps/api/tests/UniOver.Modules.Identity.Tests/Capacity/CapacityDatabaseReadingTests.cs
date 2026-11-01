using AwesomeAssertions;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Identity.Features.Capacity;

namespace UniOver.Modules.Identity.Tests.Capacity;

public class CapacityDatabaseReadingTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    private sealed class ManualTime : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class Meter
    {
        public int Calls;

        public Task<DatabaseSize> MeasureAsync(CancellationToken _)
        {
            var call = Interlocked.Increment(ref Calls);
            return Task.FromResult(new DatabaseSize(call * 1000L, []));
        }
    }

    [Fact]
    public async Task WithinTheLifetime_TheMeasureIsTakenOnce_AndKeepsItsInstant()
    {
        var time = new ManualTime();
        using var reading = new CapacityDatabaseReading(time);
        var meter = new Meter();

        var first = await reading.GetAsync(Lifetime, meter.MeasureAsync, Ct);
        time.Now = time.Now.AddMinutes(9);
        var second = await reading.GetAsync(Lifetime, meter.MeasureAsync, Ct);

        meter.Calls.Should().Be(1);
        second.Size.DatabaseBytes.Should().Be(first.Size.DatabaseBytes);
        second.MeasuredAt.Should().Be(first.MeasuredAt).And.Be(new DateTimeOffset(2026, 11, 1, 12, 0, 0, TimeSpan.Zero));
    }

    [Fact]
    public async Task AfterTheLifetime_TheDatabaseIsMeasuredAgain()
    {
        var time = new ManualTime();
        using var reading = new CapacityDatabaseReading(time);
        var meter = new Meter();

        await reading.GetAsync(Lifetime, meter.MeasureAsync, Ct);
        time.Now = time.Now.Add(Lifetime);
        var again = await reading.GetAsync(Lifetime, meter.MeasureAsync, Ct);

        meter.Calls.Should().Be(2);
        again.Size.DatabaseBytes.Should().Be(2000);
        again.MeasuredAt.Should().Be(time.Now);
    }

    [Fact]
    public async Task WithAZeroLifetime_EveryReadMeasures()
    {
        using var reading = new CapacityDatabaseReading(new ManualTime());
        var meter = new Meter();

        await reading.GetAsync(TimeSpan.Zero, meter.MeasureAsync, Ct);
        await reading.GetAsync(TimeSpan.Zero, meter.MeasureAsync, Ct);

        meter.Calls.Should().Be(2);
    }

    [Fact]
    public async Task ReadsAtTheSameTime_ShareASingleMeasure()
    {
        using var reading = new CapacityDatabaseReading(new ManualTime());
        var meter = new Meter();
        var release = new TaskCompletionSource();

        async Task<DatabaseSize> Slow(CancellationToken token)
        {
            await release.Task;
            return await meter.MeasureAsync(token);
        }

        var all = Enumerable.Range(0, 8).Select(_ => reading.GetAsync(Lifetime, Slow, Ct)).ToArray();
        release.SetResult();
        var results = await Task.WhenAll(all);

        meter.Calls.Should().Be(1);
        results.Select(r => r.Size.DatabaseBytes).Should().OnlyContain(bytes => bytes == 1000);
    }

    [Fact]
    public async Task AFailedMeasure_IsNotCached_AndTheNextReadTriesAgain()
    {
        using var reading = new CapacityDatabaseReading(new ManualTime());
        var meter = new Meter();

        var failing = () => reading.GetAsync(Lifetime, _ => throw new InvalidOperationException("banco fora"), Ct);
        await failing.Should().ThrowAsync<InvalidOperationException>();

        var ok = await reading.GetAsync(Lifetime, meter.MeasureAsync, Ct);
        ok.Size.DatabaseBytes.Should().Be(1000);
        meter.Calls.Should().Be(1);
    }

    [Fact]
    public void TheCacheOption_HasASaneDefault_AndRejectsNegativeOrHugeValues()
    {
        new CapacityOptions().DatabaseCacheMinutes.Should().Be(10);
        new CapacityOptions { DatabaseCacheMinutes = 0 }.IsValid().Should().BeTrue();
        new CapacityOptions { DatabaseCacheMinutes = -1 }.IsValid().Should().BeFalse();
        new CapacityOptions { DatabaseCacheMinutes = 61 }.IsValid().Should().BeFalse();
    }
}
