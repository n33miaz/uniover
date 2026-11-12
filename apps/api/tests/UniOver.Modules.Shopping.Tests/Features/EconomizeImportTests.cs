using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using UniOver.Modules.Shopping.Features;
using UniOver.Modules.Shopping.Infrastructure;

namespace UniOver.Modules.Shopping.Tests.Features;

public sealed class EconomizeImportTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 12, 12, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public void CursorTrail_StopsWhenACursorComesBack_EvenNotRightAway()
    {
        var trail = new EconomizeCursorTrail();

        trail.TryAdvance("A").Should().BeTrue();
        trail.TryAdvance("B").Should().BeTrue();
        trail.TryAdvance("A").Should().BeFalse("A → B → A nunca acabaria");
        trail.Pages.Should().Be(3);
    }

    [Fact]
    public void CursorTrail_StopsAtTheCeilingOfPages()
    {
        var trail = new EconomizeCursorTrail();
        var followed = 0;
        while (trail.TryAdvance("c" + followed))
        {
            followed++;
        }

        trail.Pages.Should().Be(EconomizeCursorTrail.MaxPages);
        followed.Should().Be(EconomizeCursorTrail.MaxPages - 1, "a primeira página vem sem cursor");
    }

    private static EconomizeTrip Trip(
        DateTimeOffset? startedAt = null,
        long? paid = 1000,
        string? store = "Mercado",
        EconomizeTripItem? item = null) =>
        new(Guid.NewGuid(), true, "CLOSED", store, startedAt ?? Now.AddDays(-2), Now.AddDays(-2), paid, null, null, null, Now.AddDays(-2), item is null ? [] : [item]);

    private static EconomizeTripItem Item(decimal? quantity = 1, long? unit = 500, long? line = 500, bool picked = true) =>
        new("Café", quantity, unit, line, picked, null);

    [Fact]
    public void TripLimits_AcceptAnOrdinaryTrip() =>
        EconomizeTripLimits.IsSane(Trip(item: Item()), Now).Should().BeTrue();

    [Fact]
    public void TripLimits_RejectDatesOutOfRange()
    {
        EconomizeTripLimits.IsSane(Trip(startedAt: new DateTimeOffset(1999, 12, 31, 23, 59, 0, TimeSpan.Zero)), Now).Should().BeFalse();
        EconomizeTripLimits.IsSane(Trip(startedAt: DateTimeOffset.MinValue), Now).Should().BeFalse();
        EconomizeTripLimits.IsSane(Trip(startedAt: Now.AddDays(2)), Now).Should().BeFalse();
        EconomizeTripLimits.IsSane(Trip(startedAt: Now.AddHours(23)), Now).Should().BeTrue("até amanhã, por fuso e relógio adiantado");
    }

    [Fact]
    public void TripLimits_RejectCentsQuantityAndTextOutOfRange()
    {
        EconomizeTripLimits.IsSane(Trip(paid: 100_000_001), Now).Should().BeFalse();
        EconomizeTripLimits.IsSane(Trip(paid: -1), Now).Should().BeFalse();
        EconomizeTripLimits.IsSane(Trip(paid: null, item: Item(line: long.MaxValue)), Now).Should().BeFalse();
        EconomizeTripLimits.IsSane(Trip(item: Item(quantity: 0)), Now).Should().BeFalse();
        EconomizeTripLimits.IsSane(Trip(item: Item(quantity: 10_001)), Now).Should().BeFalse();
        EconomizeTripLimits.IsSane(Trip(store: new string('x', 1001)), Now).Should().BeFalse();
        EconomizeTripLimits.IsSane(Trip(item: Item(quantity: 0, line: long.MaxValue, picked: false)), Now)
            .Should().BeTrue("a linha que não foi pega não é lida");
    }

    private sealed class ManualTime(DateTimeOffset start) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = start;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class Lifetime : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => CancellationToken.None;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication()
        {
        }
    }

    [Fact]
    public async Task Queue_ForgetsAFinishedImportAfterAnHour()
    {
        // Sem o executor registrado a importação falha na hora: basta para ver o que a fila guarda depois.
        await using var services = new ServiceCollection().BuildServiceProvider();
        var time = new ManualTime(Now);
        var queue = new EconomizeImportQueue(
            services.GetRequiredService<IServiceScopeFactory>(), new Lifetime(), time, NullLogger<EconomizeImportQueue>.Instance);
        var group = Guid.NewGuid();

        queue.Start(group, Guid.NewGuid());
        var finished = queue.Get(group);
        for (var attempt = 0; !finished.Finished && attempt < 100; attempt++)
        {
            await Task.Delay(20, Ct);
            finished = queue.Get(group);
        }

        finished.Finished.Should().BeTrue();
        finished.Error.Should().Be("unavailable");

        time.Now = Now.AddMinutes(59);
        queue.Get(group).Finished.Should().BeTrue("a tela ainda lê o resultado");

        time.Now = Now.AddMinutes(61);
        queue.Get(group).Should().Be(EconomizeImportStatusResponse.Idle);
    }
}
