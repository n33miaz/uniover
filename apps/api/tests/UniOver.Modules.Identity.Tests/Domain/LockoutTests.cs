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

    [Fact]
    public void RegisterFailure_BelowTheThreshold_DoesNotLock()
    {
        var user = NewUser();

        for (var i = 0; i < 4; i++)
        {
            user.RegisterFailure(Now, Policy);
        }

        user.IsLockedOut(Now).Should().BeFalse();
        user.FailedLoginCount.Should().Be(4);
        user.LastFailedAt.Should().Be(Now);
    }

    [Fact]
    public void RegisterFailure_AtTheThreshold_LocksForOneMinute_AndThenGrows()
    {
        var user = NewUser();
        for (var i = 0; i < 5; i++)
        {
            user.RegisterFailure(Now, Policy);
        }

        user.IsLockedOut(Now).Should().BeTrue();
        user.RemainingLockout(Now).Should().Be(TimeSpan.FromMinutes(1));
        user.IsLockedOut(Now.AddSeconds(60)).Should().BeFalse("o bloqueio acaba no instante exato");

        user.RegisterFailure(Now.AddMinutes(1), Policy);
        user.RemainingLockout(Now.AddMinutes(1)).Should().Be(TimeSpan.FromMinutes(2));
    }

    [Fact]
    public void RegisterSuccess_ClearsTheCounterAndTheLock()
    {
        var user = NewUser();
        for (var i = 0; i < 6; i++)
        {
            user.RegisterFailure(Now, Policy);
        }

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
