using AwesomeAssertions;
using UniOver.Modules.Identity.Features.Capacity;

namespace UniOver.Modules.Identity.Tests.Capacity;

public class CapacityMathTests
{
    private const long Gib = 1024L * 1024 * 1024;
    private const long Mib = 1024L * 1024;

    [Theory]
    [InlineData(0, "green")]
    [InlineData(49.99, "green")]
    [InlineData(50, "amber")]
    [InlineData(79.99, "amber")]
    [InlineData(80, "red")]
    [InlineData(100, "red")]
    [InlineData(140, "red")]
    public void Bands_SwitchExactlyAtFiftyAndEighty(double percent, string expected) =>
        CapacityBands.Of(percent).Should().Be(expected);

    [Fact]
    public void PercentOf_IsZero_WhenTheLimitIsZero() => CapacityBands.PercentOf(10, 0).Should().Be(0);

    [Fact]
    public void PercentOf_DividesUsedByTheLimit() => CapacityBands.PercentOf(512 * Mib, Gib).Should().BeApproximately(50, 0.0001);

    private static (DateOnly Day, long Bytes) Sample(int day, long bytes) => (new DateOnly(2026, 10, day), bytes);

    [Fact]
    public void Trend_WithNoSamples_OrASingleOne_HasNoDates()
    {
        CapacityTrend.Compute([], 10 * Mib, Gib).State.Should().Be(CapacityGrowth.FewSamples);

        var single = CapacityTrend.Compute([Sample(1, 10 * Mib)], 10 * Mib, Gib);
        single.State.Should().Be(CapacityGrowth.FewSamples);
        single.BytesPerDay.Should().BeNull();
        single.DaysToAmber.Should().BeNull();
        single.DaysToRed.Should().BeNull();
        single.Points.Should().HaveCount(1);
    }

    [Fact]
    public void Trend_WithSteadyGrowth_ProjectsTheDaysToEachThreshold()
    {
        // 10 MiB por dia, hoje em 100 MiB: 50% do GiB são 512 MiB, 80% são 819,2 MiB.
        var samples = new[] { Sample(1, 70 * Mib), Sample(2, 80 * Mib), Sample(3, 90 * Mib), Sample(4, 100 * Mib) };

        var growth = CapacityTrend.Compute(samples, 100 * Mib, Gib);

        growth.State.Should().Be(CapacityGrowth.Growing);
        growth.BytesPerDay.Should().BeApproximately(10 * Mib, 1);
        growth.DaysToAmber.Should().BeApproximately(41.2, 0.01);
        growth.DaysToRed.Should().BeApproximately(71.92, 0.01);
    }

    [Fact]
    public void Trend_IgnoresTheOrderOfTheInput_AndGapsInTheDays()
    {
        // Os dias 1 e 5 (com folga) e o 3 fora de ordem: a reta usa a distância real entre os dias.
        var growth = CapacityTrend.Compute([Sample(5, 50 * Mib), Sample(1, 10 * Mib), Sample(3, 30 * Mib)], 50 * Mib, Gib);

        growth.Points.Select(p => p.Day).Should().Equal("2026-10-01", "2026-10-03", "2026-10-05");
        growth.BytesPerDay.Should().BeApproximately(10 * Mib, 1);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    public void Trend_WithNoGrowthOrShrinking_HasNoDate_WhileBelowTheThresholds(int deltaMiB)
    {
        var samples = new[] { Sample(1, 100 * Mib), Sample(2, (100 + deltaMiB) * Mib), Sample(3, (100 + (2 * deltaMiB)) * Mib) };

        var growth = CapacityTrend.Compute(samples, 100 * Mib, Gib);

        growth.State.Should().Be(CapacityGrowth.Flat);
        growth.DaysToAmber.Should().BeNull();
        growth.DaysToRed.Should().BeNull();
    }

    [Fact]
    public void Trend_ReportsZeroDays_WhenAThresholdWasAlreadyPassed()
    {
        // 60% do GiB: já passou do âmbar (0 dias) e ainda falta chegar ao vermelho.
        var current = (long)(Gib * 0.6);
        var growth = CapacityTrend.Compute([Sample(1, current - (20 * Mib)), Sample(2, current)], current, Gib);

        growth.DaysToAmber.Should().Be(0);
        growth.DaysToRed.Should().BeGreaterThan(0);

        // Estável porém já vermelho: a data é hoje, não "sem data".
        var red = (long)(Gib * 0.9);
        var flat = CapacityTrend.Compute([Sample(1, red), Sample(2, red)], red, Gib);
        flat.State.Should().Be(CapacityGrowth.Flat);
        flat.DaysToAmber.Should().Be(0);
        flat.DaysToRed.Should().Be(0);
    }

    [Fact]
    public void MonthHours_AreTheDaysElapsedTimesTwentyFour_RestartingEachMonth()
    {
        CapacityHours.MonthToDate(new DateTimeOffset(2026, 11, 1, 0, 0, 0, TimeSpan.Zero)).Should().Be(0);
        CapacityHours.MonthToDate(new DateTimeOffset(2026, 10, 25, 0, 0, 0, TimeSpan.Zero)).Should().Be(24 * 24);
        CapacityHours.MonthToDate(new DateTimeOffset(2026, 10, 31, 12, 0, 0, TimeSpan.Zero)).Should().Be(30.5 * 24);

        // O fuso não muda o mês: 22h de 30/10 em -03:00 já é 31/10 01h em UTC.
        CapacityHours.MonthToDate(new DateTimeOffset(2026, 10, 30, 22, 0, 0, TimeSpan.FromHours(-3))).Should().Be((30 * 24) + 1);
    }

    [Fact]
    public void MonthProjection_IsTheWholeMonthTimesTheServices()
    {
        var october = new DateTimeOffset(2026, 10, 5, 0, 0, 0, TimeSpan.Zero);
        var february = new DateTimeOffset(2027, 2, 5, 0, 0, 0, TimeSpan.Zero);

        CapacityHours.MonthProjection(october, 1).Should().Be(744);
        CapacityHours.MonthProjection(february, 1).Should().Be(672);
        CapacityHours.MonthProjection(october, 2).Should().Be(1488);
    }

    [Theory]
    [InlineData(1, 10, "neutral", 0)]
    [InlineData(1, 2, "neutral", 0)]
    public void Hours_WithOneAlwaysOnService_AreOnlyInformative_AndNeverAlert(int services, int month, string band, double alert)
    {
        var options = new CapacityOptions { ServicesInWorkspace = services };
        // Mês de 31 dias (744 h) ou de 28 dias (672 h): a projeção cabe em 750 h.
        var now = new DateTimeOffset(2026, month, 28, 12, 0, 0, TimeSpan.Zero);

        CapacityHours.Band(now, options).Should().Be(band);
        CapacityHours.AlertPercent(now, options).Should().Be(alert);
    }

    [Fact]
    public void Hours_TurnRedAndAlert_OnlyWhenTheProjectedMonthPassesTheLimit()
    {
        var now = new DateTimeOffset(2026, 10, 2, 0, 0, 0, TimeSpan.Zero);
        var two = new CapacityOptions { ServicesInWorkspace = 2 };

        CapacityHours.Band(now, two).Should().Be("red");
        CapacityHours.AlertPercent(now, two).Should().BeApproximately(1488d / 750 * 100, 0.0001);

        // 31 dias x 24 = 744: exatamente no limite de 744 não passa; um limite de 743 passa.
        CapacityHours.Band(now, new CapacityOptions { MonthlyHoursLimit = 744 }).Should().Be("neutral");
        CapacityHours.Band(now, new CapacityOptions { MonthlyHoursLimit = 743 }).Should().Be("red");
    }

    [Fact]
    public void Options_DefaultsAreTheFreePlan_AndRejectNonsense()
    {
        var defaults = new CapacityOptions();
        defaults.DatabaseLimitBytes.Should().Be(Gib);
        defaults.MemoryLimitBytes.Should().Be(512 * Mib);
        defaults.MonthlyHoursLimit.Should().Be(750);
        defaults.RetentionDays.Should().Be(120);
        defaults.ServicesInWorkspace.Should().Be(1);
        defaults.IsValid().Should().BeTrue();

        new CapacityOptions { DatabaseLimitBytes = 0 }.IsValid().Should().BeFalse();
        new CapacityOptions { MemoryLimitMb = 0 }.IsValid().Should().BeFalse();
        new CapacityOptions { MonthlyHoursLimit = 0 }.IsValid().Should().BeFalse();
        new CapacityOptions { RetentionDays = 7 }.IsValid().Should().BeFalse();
        new CapacityOptions { ServicesInWorkspace = 0 }.IsValid().Should().BeFalse();
        new CapacityOptions { ServicesInWorkspace = 21 }.IsValid().Should().BeFalse();
    }
}
