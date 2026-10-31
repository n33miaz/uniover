using AwesomeAssertions;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Tests.Domain;

public class UserPauseTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    private static User Guest() => User.CreateGuest("bia@exemplo.com", "Bia", "hash", Now);

    [Fact]
    public void Pause_BlocksTheGuest_WithoutRevoking_AndResumeUndoesIt()
    {
        var guest = Guest();

        guest.Pause(Now);

        guest.IsPaused.Should().BeTrue();
        guest.IsBlocked.Should().BeTrue();
        guest.IsDisabled.Should().BeFalse("pausar não revoga");

        guest.Resume();

        guest.IsPaused.Should().BeFalse();
        guest.IsBlocked.Should().BeFalse();
    }

    [Fact]
    public void Pause_KeepsTheFirstMoment_WhenRepeated()
    {
        var guest = Guest();

        guest.Pause(Now);
        guest.Pause(Now.AddHours(1));

        guest.PausedAt.Should().Be(Now);
    }

    [Fact]
    public void Pause_RefusesTheOwner_AndARevokedGuest()
    {
        var owner = User.Create("dono@exemplo.com", "Dono", "hash", Now);
        var revoked = Guest();
        revoked.Disable(Now);

        var pauseOwner = () => owner.Pause(Now);
        var pauseRevoked = () => revoked.Pause(Now);

        pauseOwner.Should().Throw<InvalidOperationException>();
        pauseRevoked.Should().Throw<InvalidOperationException>();
        owner.IsPaused.Should().BeFalse();
    }
}
