using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Tests.Domain;

public class TvPermissionStateTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 31, 12, 0, 0, TimeSpan.Zero);

    private static ConfiguredTv NewTv() => ConfiguredTv.Create("TV Raphael", "pc-raphael", isDefault: false, Guid.NewGuid(), Now);

    [Fact]
    public void ANewTvDoesNotNeedPermission()
    {
        var tv = NewTv();

        tv.PermissionNeeded.Should().BeFalse();
        tv.PermissionChangedAt.Should().BeNull();
    }

    [Fact]
    public void SayingNeeded_RecordsTheStateAndTheMoment_WithoutTouchingWhoEditedTheTv()
    {
        var tv = NewTv();
        var editedBy = tv.UpdatedBy;
        var updatedAt = tv.UpdatedAt;
        var at = Now.AddMinutes(5);

        tv.SetPermissionNeeded(true, at).Should().BeTrue();

        tv.PermissionNeeded.Should().BeTrue();
        tv.PermissionChangedAt.Should().Be(at);
        tv.UpdatedBy.Should().Be(editedBy, "quem avisa é o agente, não uma conta");
        tv.UpdatedAt.Should().Be(updatedAt);
    }

    [Fact]
    public void RepeatingTheSameState_ChangesNothing_NotEvenTheDate()
    {
        var tv = NewTv();
        tv.SetPermissionNeeded(true, Now.AddMinutes(1));

        tv.SetPermissionNeeded(true, Now.AddMinutes(30)).Should().BeFalse();

        tv.PermissionChangedAt.Should().Be(Now.AddMinutes(1));
    }

    [Fact]
    public void Granting_ClearsTheState()
    {
        var tv = NewTv();
        tv.SetPermissionNeeded(true, Now);

        tv.SetPermissionNeeded(false, Now.AddMinutes(2)).Should().BeTrue();

        tv.PermissionNeeded.Should().BeFalse();
        tv.PermissionChangedAt.Should().Be(Now.AddMinutes(2));
    }

    [Fact]
    public void SayingGrantedOnATvThatNeverNeededIt_IsNotAChange()
    {
        var tv = NewTv();

        tv.SetPermissionNeeded(false, Now).Should().BeFalse();

        tv.PermissionChangedAt.Should().BeNull();
    }

    [Fact]
    public void ThePermissionRequestMessage_HasAnEmptyBody_AndNeverCarriesAnAddress()
    {
        var message = TvMessages.PermissionRequest();

        message.Type.Should().Be("tv.permission.request.v1");
        message.Body.GetRawText().Should().Be("{}");
    }

    [Fact]
    public void TheDiscoverMessage_CarriesOnlyTheRequestId()
    {
        var requestId = Guid.NewGuid();

        var message = TvMessages.Discover(requestId);

        message.Type.Should().Be("tv.discover.v1");
        message.Body.GetRawText().Should().Be($"{{\"requestId\":\"{requestId}\"}}");
    }

    [Fact]
    public void TheMessageTypesComeFromTheGeneratedContract()
    {
        AgentMessageTypes.TvPermissionV1.Should().Be("tv.permission.v1");
        AgentMessageTypes.TvDiscoveryV1.Should().Be("tv.discovery.v1");
    }

    [Fact]
    public async Task Discovery_DeliversTheListOnlyToTheSearchOfThatComputerAndThatRequest()
    {
        var reports = new InMemoryTvDiscoveryReports(TimeProvider.System);
        using var ticket = reports.TryBegin("pc-raphael")!;
        var wanted = new[] { new TvNearby("a1b2c3d4e5f60718", "samsung", "Sala", true) };

        reports.Complete("pc-outro", ticket.RequestId, [new TvNearby("x", "samsung", null, false)]);
        reports.Complete("pc-raphael", Guid.NewGuid(), [new TvNearby("y", "samsung", null, false)]);
        (await ticket.WaitAsync(TimeSpan.FromMilliseconds(20), TestContext.Current.CancellationToken)).Should().BeNull();

        reports.Complete("pc-raphael", ticket.RequestId, wanted);
        (await ticket.WaitAsync(TimeSpan.FromSeconds(1), TestContext.Current.CancellationToken)).Should().Equal(wanted);
    }

    [Fact]
    public void Discovery_AllowsOneSearchPerComputer_AndReleasesTheTurnWhenItEnds()
    {
        var reports = new InMemoryTvDiscoveryReports(TimeProvider.System);
        var first = reports.TryBegin("pc-raphael");

        first.Should().NotBeNull();
        reports.TryBegin("pc-raphael").Should().BeNull("duas varreduras no mesmo computador disputariam a rede");
        reports.TryBegin("pc-outro").Should().NotBeNull();
        first!.Dispose();
        reports.TryBegin("pc-raphael").Should().NotBeNull();
    }

    [Fact]
    public void Discovery_IgnoresAListNobodyIsWaitingFor()
    {
        var reports = new InMemoryTvDiscoveryReports(TimeProvider.System);

        var act = () => reports.Complete("pc-raphael", Guid.NewGuid(), []);

        act.Should().NotThrow();
    }
}
