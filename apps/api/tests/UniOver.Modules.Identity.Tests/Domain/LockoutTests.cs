using AwesomeAssertions;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Tests.Domain;

public class LockoutTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);
    private static readonly LockoutPolicy Policy = LockoutPolicy.Default;

    private static User NewUser() => User.Create("dono@uniover.test", "dono", "hash", Now);

    [Theory]
    [InlineData(1, 0)]
    [InlineData(4, 0)]
    [InlineData(5, 60)]
    [InlineData(6, 120)]
    [InlineData(7, 240)]
    [InlineData(8, 480)]
    [InlineData(9, 900)]
    [InlineData(10, 900)]
    [InlineData(500, 900)]
    public void DelayFor_StartsAtFiveFailures_DoublesAndCapsAtFifteenMinutes(int failures, int seconds)
    {
        Policy.DelayFor(failures).Should().Be(TimeSpan.FromSeconds(seconds));
    }

    [Fact]
    public void DefaultPolicy_MatchesWhatTheOwnerApproved()
    {
        Policy.Threshold.Should().Be(5);
        Policy.BaseDelay.Should().Be(TimeSpan.FromMinutes(1));
        Policy.MaxDelay.Should().Be(TimeSpan.FromMinutes(15));
    }

    // A contagem da falha e o bloqueio dela (limiar, dobra, teto) são provados em IntegrationTests (FailedLoginCounterTests),
    // contra o banco, porque o ponto é justamente a atomicidade dele; aqui fica a política pura (DelayFor, acima).

    [Fact]
    public void RegisterSuccess_OnACleanAccount_LeavesItUnlocked()
    {
        var user = NewUser();

        user.RegisterSuccess();

        user.FailedLoginCount.Should().Be(0);
        user.LockoutUntil.Should().BeNull();
        user.IsLockedOut(Now).Should().BeFalse();
        user.RemainingLockout(Now).Should().Be(TimeSpan.Zero);
    }

    [Fact]
    public void Create_NormalizesTheEmail_AndStartsClean()
    {
        var user = User.Create("  DONO@Uniover.Test ", " Dono ", "hash", Now);

        user.Email.Should().Be("dono@uniover.test");
        user.DisplayName.Should().Be("Dono");
        user.FailedLoginCount.Should().Be(0);
        user.Id.Should().NotBeEmpty();
        user.CreatedAt.Should().Be(Now);
    }
}
