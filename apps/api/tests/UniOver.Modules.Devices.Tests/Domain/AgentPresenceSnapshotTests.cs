using AwesomeAssertions;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;

namespace UniOver.Modules.Devices.Tests.Domain;

public class AgentPresenceSnapshotTests
{
    private const string Sha = "3f2a9c1d4e5b6a7988776655443322110fedcba9";

    [Fact]
    public void NewSnapshot_KnowsNothingYet()
    {
        var snapshot = AgentPresenceSnapshot.Create(Guid.NewGuid());

        snapshot.LastSeenAt.Should().BeNull();
        snapshot.AgentVersion.Should().BeNull();
        snapshot.Host.Should().BeNull();
        snapshot.Update.Should().BeNull();
    }

    [Fact]
    public void RecordUpdate_ReturnsTheSameStateTheAgentReported()
    {
        var snapshot = AgentPresenceSnapshot.Create(Guid.NewGuid());
        var reported = new AgentUpdateInfo(
            "failed",
            Sha,
            DateTimeOffset.Parse("2026-10-20T09:15:00Z", System.Globalization.CultureInfo.InvariantCulture),
            Sha,
            DateTimeOffset.Parse("2026-10-24T13:40:00Z", System.Globalization.CultureInfo.InvariantCulture),
            null,
            "sem acesso ao pacote",
            null,
            Sha,
            true);

        snapshot.RecordUpdate(reported);

        snapshot.Update.Should().Be(reported);
    }

    [Fact]
    public void RecordHello_KeepsVersionAndHost_AndReplacesThemOnTheNextHello()
    {
        var snapshot = AgentPresenceSnapshot.Create(Guid.NewGuid());

        snapshot.RecordHello("0.1.0+3f2a9c1d4e5b", new AgentHostInfo("Windows 11", "android", "192.168.0.20"));
        snapshot.RecordHello("0.2.0", null);

        snapshot.AgentVersion.Should().Be("0.2.0");
        snapshot.Host.Should().BeNull();
    }
}
