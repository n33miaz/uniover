using AwesomeAssertions;
using UniOver.Modules.Devices.Domain;

namespace UniOver.Modules.Devices.Tests.Domain;

public class PairingRequestTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Validity = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private static PairingRequest NewPairing() =>
        PairingRequest.Create([1, 2, 3], "BCDFGHJK", "PC Casa", "pc-casa", "windows", "0.1.0", Now, Validity);

    [Fact]
    public void Create_SetsTheExpiryFromTheValidity()
    {
        NewPairing().ExpiresAt.Should().Be(Now + Validity);
    }

    [Fact]
    public void Evaluate_FirstPoll_IsPending()
    {
        NewPairing().Evaluate(Now.AddSeconds(1), Interval).Should().Be(PollOutcome.Pending);
    }

    [Fact]
    public void Evaluate_PollFasterThanTheInterval_IsSlowDown()
    {
        var pairing = NewPairing();
        pairing.RegisterPoll(Now);

        pairing.Evaluate(Now.AddSeconds(4), Interval).Should().Be(PollOutcome.SlowDown);
    }

    [Fact]
    public void Evaluate_PollExactlyAtTheInterval_IsPending()
    {
        var pairing = NewPairing();
        pairing.RegisterPoll(Now);

        pairing.Evaluate(Now.AddSeconds(5), Interval).Should().Be(PollOutcome.Pending);
    }

    [Fact]
    public void Evaluate_AtTheExpiryInstant_IsExpired_AndOneSecondBeforeIsNot()
    {
        var pairing = NewPairing();

        pairing.Evaluate(Now + Validity, Interval).Should().Be(PollOutcome.Expired);
        pairing.Evaluate(Now + Validity - TimeSpan.FromSeconds(1), Interval).Should().Be(PollOutcome.Pending);
    }

    [Fact]
    public void Evaluate_Approved_IsNeverHeldBackBySlowDown()
    {
        var pairing = NewPairing();
        pairing.RegisterPoll(Now);
        pairing.Approve(Now.AddSeconds(1), Guid.NewGuid(), "PC Casa", Guid.NewGuid());

        pairing.Evaluate(Now.AddSeconds(2), Interval).Should().Be(PollOutcome.Approved);
    }

    [Fact]
    public void Evaluate_ApprovedPairing_StaysApprovedEvenAfterTheCodeWouldHaveExpired()
    {
        var pairing = NewPairing();
        pairing.Approve(Now.AddSeconds(1), Guid.NewGuid(), "PC Casa", Guid.NewGuid());

        pairing.Evaluate(Now + Validity + TimeSpan.FromMinutes(1), Interval).Should().Be(PollOutcome.Approved);
    }

    [Fact]
    public void Evaluate_AfterConsume_IsConsumed()
    {
        var pairing = NewPairing();
        pairing.Approve(Now, Guid.NewGuid(), "PC Casa", Guid.NewGuid());
        pairing.Consume(Now.AddSeconds(6));

        pairing.Evaluate(Now.AddSeconds(30), Interval).Should().Be(PollOutcome.Consumed);
    }

    [Fact]
    public void Evaluate_Denied_IsDenied()
    {
        var pairing = NewPairing();
        pairing.Deny(Now.AddSeconds(1));

        pairing.Evaluate(Now.AddSeconds(30), Interval).Should().Be(PollOutcome.Denied);
    }

    [Fact]
    public void Approve_RecordsWhoApprovedTheFinalNameAndTheAgent()
    {
        var pairing = NewPairing();
        var user = Guid.NewGuid();
        var agent = Guid.NewGuid();

        pairing.Approve(Now.AddMinutes(1), user, "Sala", agent);

        pairing.ApprovedBy.Should().Be(user);
        pairing.ApprovedName.Should().Be("Sala");
        pairing.AgentId.Should().Be(agent);
        pairing.ApprovedAt.Should().Be(Now.AddMinutes(1));
    }

    [Fact]
    public void Approve_Twice_IsRefused()
    {
        var pairing = NewPairing();
        pairing.Approve(Now, Guid.NewGuid(), "PC Casa", Guid.NewGuid());

        var again = () => pairing.Approve(Now, Guid.NewGuid(), "Outro", Guid.NewGuid());

        again.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void Approve_AfterTheExpiry_IsRefused()
    {
        var pairing = NewPairing();

        var late = () => pairing.Approve(Now + Validity, Guid.NewGuid(), "PC Casa", Guid.NewGuid());

        late.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void Approve_AfterDeny_IsRefused()
    {
        var pairing = NewPairing();
        pairing.Deny(Now);

        var approve = () => pairing.Approve(Now, Guid.NewGuid(), "PC Casa", Guid.NewGuid());

        approve.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void Consume_WithoutApproval_OrTwice_IsRefused()
    {
        var pairing = NewPairing();
        var early = () => pairing.Consume(Now);
        early.Should().Throw<InvalidOperationException>();

        pairing.Approve(Now, Guid.NewGuid(), "PC Casa", Guid.NewGuid());
        pairing.Consume(Now);
        var twice = () => pairing.Consume(Now);
        twice.Should().Throw<InvalidOperationException>();
    }

    [Theory]
    [InlineData(false, false, false, false, true)]
    [InlineData(true, false, false, false, false)]
    [InlineData(false, true, false, false, false)]
    [InlineData(false, false, true, false, false)]
    [InlineData(false, false, false, true, false)]
    public void IsOpenAt_RequiresNoDecisionAndTimeLeft(bool expired, bool approved, bool denied, bool consumed, bool expected)
    {
        var pairing = NewPairing();
        if (approved || consumed)
        {
            pairing.Approve(Now, Guid.NewGuid(), "PC Casa", Guid.NewGuid());
        }

        if (consumed)
        {
            pairing.Consume(Now);
        }

        if (denied)
        {
            pairing = NewPairing();
            pairing.Deny(Now);
        }

        var at = expired ? Now + Validity : Now.AddSeconds(1);

        pairing.IsOpenAt(at).Should().Be(expected);
    }
}

public class AgentTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);

    private static Agent NewAgent() => Agent.Create(Guid.NewGuid(), "pc-casa", "PC Casa", "windows", Guid.NewGuid(), Now);

    [Fact]
    public void Create_RejectsASlugOutsideTheEnvelopePattern()
    {
        var bad = () => Agent.Create(Guid.NewGuid(), "PC Casa", "PC Casa", "windows", Guid.NewGuid(), Now);

        bad.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void NewAgent_HasNoTokenYet()
    {
        NewAgent().TokenHash.Should().BeNull();
    }

    [Fact]
    public void IssueToken_OnlyOnce_AndNeverForARevokedAgent()
    {
        var agent = NewAgent();
        agent.IssueToken([1]);
        var twice = () => agent.IssueToken([2]);
        twice.Should().Throw<InvalidOperationException>();

        var revoked = NewAgent();
        revoked.Revoke(Now, Guid.NewGuid(), null);
        var afterRevoke = () => revoked.IssueToken([1]);
        afterRevoke.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void Revoke_IsIdempotent_AndKeepsTheFirstRevocation()
    {
        var agent = NewAgent();
        var first = Guid.NewGuid();

        agent.Revoke(Now.AddMinutes(1), first, "perdi o PC").Should().BeTrue();
        agent.Revoke(Now.AddMinutes(2), Guid.NewGuid(), "outro").Should().BeFalse();

        agent.IsRevoked.Should().BeTrue();
        agent.RevokedAt.Should().Be(Now.AddMinutes(1));
        agent.RevokedBy.Should().Be(first);
        agent.RevokeReason.Should().Be("perdi o PC");
    }

    [Fact]
    public void Revoke_TruncatesALongReason()
    {
        var agent = NewAgent();

        agent.Revoke(Now, Guid.NewGuid(), new string('x', 500));

        agent.RevokeReason.Should().HaveLength(Agent.ReasonMax);
    }
}
