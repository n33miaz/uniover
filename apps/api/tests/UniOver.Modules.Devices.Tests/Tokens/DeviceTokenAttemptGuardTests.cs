using AwesomeAssertions;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Features.Tokens;

namespace UniOver.Modules.Devices.Tests.Tokens;

public sealed class DeviceTokenAttemptGuardTests
{
    private static readonly DateTimeOffset Start = new(2026, 10, 31, 12, 0, 0, TimeSpan.Zero);

    private sealed class ManualTime(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static InMemoryDeviceTokenAttemptGuard Build(ManualTime time, int limit = 3, int windowSeconds = 60) =>
        new(time, Options.Create(new DevicesModuleOptions { TokenFailureLimit = limit, TokenFailureWindowSeconds = windowSeconds }));

    [Fact]
    public void BlocksAnOriginOnlyAfterTheLimitOfFailures()
    {
        var guard = Build(new ManualTime(Start));

        guard.RecordFailure("a");
        guard.RecordFailure("a");
        guard.IsBlocked("a", out _).Should().BeFalse();

        guard.RecordFailure("a");
        guard.IsBlocked("a", out var retryAfter).Should().BeTrue();
        retryAfter.Should().Be(TimeSpan.FromSeconds(60));
    }

    [Fact]
    public void AnotherOriginIsNotAffected()
    {
        var guard = Build(new ManualTime(Start));
        for (var i = 0; i < 5; i++)
        {
            guard.RecordFailure("a");
        }

        guard.IsBlocked("a", out _).Should().BeTrue();
        guard.IsBlocked("b", out _).Should().BeFalse();
    }

    [Fact]
    public void TheWindowEnds_AndTheCountStartsOver()
    {
        var time = new ManualTime(Start);
        var guard = Build(time);
        for (var i = 0; i < 3; i++)
        {
            guard.RecordFailure("a");
        }

        time.Now = Start.AddSeconds(30);
        guard.IsBlocked("a", out var retryAfter).Should().BeTrue();
        retryAfter.Should().Be(TimeSpan.FromSeconds(30));

        time.Now = Start.AddSeconds(60);
        guard.IsBlocked("a", out _).Should().BeFalse();

        guard.RecordFailure("a");
        guard.IsBlocked("a", out _).Should().BeFalse("a janela nova começou do zero");
    }

    [Fact]
    public void TheTableIsBounded_ExpiredOriginsAreSweptAndNewOnesAreNotCountedWhenItIsFull()
    {
        var time = new ManualTime(Start);
        var guard = Build(time);
        for (var i = 0; i < InMemoryDeviceTokenAttemptGuard.MaxTrackedClients; i++)
        {
            guard.RecordFailure("ip-" + i);
        }

        guard.TrackedClients.Should().Be(InMemoryDeviceTokenAttemptGuard.MaxTrackedClients);

        // Cheia e nada vencido: a origem nova não entra (falha aberta), a memória não cresce.
        for (var i = 0; i < 5; i++)
        {
            guard.RecordFailure("novo");
        }

        guard.TrackedClients.Should().Be(InMemoryDeviceTokenAttemptGuard.MaxTrackedClients);
        guard.IsBlocked("novo", out _).Should().BeFalse();

        // Tudo vencido: a varredura abre espaço e a origem nova volta a ser contada.
        time.Now = Start.AddMinutes(2);
        for (var i = 0; i < 3; i++)
        {
            guard.RecordFailure("novo");
        }

        guard.TrackedClients.Should().BeLessThan(InMemoryDeviceTokenAttemptGuard.MaxTrackedClients);
        guard.IsBlocked("novo", out _).Should().BeTrue();
    }
}
