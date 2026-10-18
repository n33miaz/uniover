using AwesomeAssertions;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Tests.Domain;

public class RefreshTokenTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Grace = TimeSpan.FromSeconds(3);

    private static RefreshToken NewToken(DateTimeOffset? expiresAt = null) =>
        RefreshToken.Create(Guid.NewGuid(), Guid.NewGuid(), [1, 2, 3], Now, expiresAt ?? Now.AddDays(14), "127.0.0.1", "agente");

    [Fact]
    public void Evaluate_FreshToken_IsValid()
    {
        NewToken().Evaluate(Now.AddDays(1), Grace).Should().Be(RefreshDecision.Valid);
    }

    [Fact]
    public void Evaluate_UnusedTokenPastItsExpiry_IsExpired()
    {
        var token = NewToken(Now.AddDays(14));

        token.Evaluate(Now.AddDays(14), Grace).Should().Be(RefreshDecision.Expired);
        token.Evaluate(Now.AddDays(14).AddSeconds(-1), Grace).Should().Be(RefreshDecision.Valid);
    }

    [Fact]
    public void Evaluate_UsedTokenWithinTheTolerance_IsAConflict_NotAReuse()
    {
        var token = NewToken();
        token.MarkRotated(Now, Guid.NewGuid());

        token.Evaluate(Now.AddSeconds(3), Grace).Should().Be(RefreshDecision.Conflict);
    }

    [Fact]
    public void Evaluate_UsedTokenOutsideTheTolerance_IsReuse()
    {
        var token = NewToken();
        token.MarkRotated(Now, Guid.NewGuid());

        token.Evaluate(Now.AddSeconds(3).AddMilliseconds(1), Grace).Should().Be(RefreshDecision.Reuse);
    }

    [Fact]
    public void Evaluate_UsedAndExpiredToken_IsReuseNotExpired()
    {
        var token = NewToken(Now.AddDays(1));
        token.MarkRotated(Now, Guid.NewGuid());

        token.Evaluate(Now.AddDays(5), Grace).Should().Be(RefreshDecision.Reuse);
    }

    [Fact]
    public void Evaluate_RevokedToken_IsAlwaysReuse_EvenInsideTheTolerance()
    {
        var token = NewToken();
        token.Revoke(Now, RevokeReasons.Logout);

        token.Evaluate(Now, Grace).Should().Be(RefreshDecision.Reuse);
    }

    [Fact]
    public void Revoke_KeepsTheFirstReason()
    {
        var token = NewToken();

        token.Revoke(Now, RevokeReasons.Reuse);
        token.Revoke(Now.AddMinutes(1), RevokeReasons.Logout);

        token.RevokedReason.Should().Be("reuse");
        token.RevokedAt.Should().Be(Now);
    }

    [Fact]
    public void MarkRotated_PointsToTheSuccessor()
    {
        var token = NewToken();
        var next = Guid.NewGuid();

        token.MarkRotated(Now, next);

        token.UsedAt.Should().Be(Now);
        token.ReplacedById.Should().Be(next);
    }

    [Fact]
    public void Create_TruncatesTheClientTextToTheColumnLimits()
    {
        var token = RefreshToken.Create(Guid.NewGuid(), Guid.NewGuid(), [1], Now, Now.AddDays(1), new string('1', 200), new string('a', 600));

        token.Ip.Should().HaveLength(AuditText.IpMax);
        token.UserAgent.Should().HaveLength(AuditText.UserAgentMax);
    }
}

public class RefreshPolicyTests
{
    private static readonly DateTimeOffset Start = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly RefreshPolicy Policy = RefreshPolicy.Default;

    [Fact]
    public void Default_MatchesWhatTheOwnerApproved()
    {
        Policy.SlidingWindow.Should().Be(TimeSpan.FromDays(14));
        Policy.AbsoluteLifetime.Should().Be(TimeSpan.FromDays(90));
        Policy.ReuseGrace.Should().Be(TimeSpan.FromSeconds(3));
    }

    [Fact]
    public void ExpiryFor_SlidesBy14Days()
    {
        Policy.ExpiryFor(Start.AddDays(10), Start).Should().Be(Start.AddDays(24));
    }

    [Fact]
    public void ExpiryFor_NeverPassesTheAbsoluteCeilingOfTheFamily()
    {
        Policy.ExpiryFor(Start.AddDays(80), Start).Should().Be(Start.AddDays(90));
    }

    [Fact]
    public void FamilyExpired_FlipsExactlyAtNinetyDays()
    {
        Policy.FamilyExpired(Start.AddDays(90).AddTicks(-1), Start).Should().BeFalse();
        Policy.FamilyExpired(Start.AddDays(90), Start).Should().BeTrue();
    }
}

public class LoginAuditEntryTests
{
    [Fact]
    public void Create_TruncatesUserAgentAndDetail_AndAcceptsAnUnknownUser()
    {
        var entry = LoginAuditEntry.Create(
            null, AuditEvents.LoginFailed, DateTimeOffset.UnixEpoch, "203.0.113.1", new string('u', 1000), new string('d', 1000));

        entry.UserId.Should().BeNull();
        entry.UserAgent.Should().HaveLength(AuditText.UserAgentMax);
        entry.Detail.Should().HaveLength(AuditText.DetailMax);
        entry.Event.Should().Be("login_failed");
    }

    [Fact]
    public void AuditEvents_HaveTheStableNames()
    {
        new[]
        {
            AuditEvents.LoginSucceeded, AuditEvents.LoginFailed, AuditEvents.LoginLocked, AuditEvents.RefreshSucceeded,
            AuditEvents.RefreshReuseDetected, AuditEvents.Logout, AuditEvents.OwnerCreated,
        }.Should().Equal(
            "login_succeeded", "login_failed", "login_locked", "refresh_succeeded", "refresh_reuse_detected", "logout", "owner_created");
    }
}
