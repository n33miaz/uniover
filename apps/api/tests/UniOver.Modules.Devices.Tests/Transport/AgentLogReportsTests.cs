using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.RemoteCare;

namespace UniOver.Modules.Devices.Tests.Transport;

public sealed class AgentLogReportsTests
{
    private static readonly AgentLogReport Report = new("linha", 1, false, DateTimeOffset.UnixEpoch);

    [Fact]
    public async Task TheReportOfTheAskedAgentAndRequestCompletesTheWait()
    {
        var reports = new InMemoryAgentLogReports(TimeProvider.System);
        using var ticket = reports.TryBegin("pc-casa")!;

        reports.Complete("pc-casa", ticket.RequestId, Report).Should().BeTrue();

        (await ticket.WaitAsync(TimeSpan.FromSeconds(1), TestContext.Current.CancellationToken)).Should().Be(Report);
    }

    [Fact]
    public void AReportFromAnotherAgent_OrForAnotherRequest_IsNotAccepted()
    {
        var reports = new InMemoryAgentLogReports(TimeProvider.System);
        using var ticket = reports.TryBegin("pc-casa")!;

        reports.Complete("outro", ticket.RequestId, Report).Should().BeFalse("só vale o registro de quem foi perguntado");
        reports.Complete("pc-casa", Guid.CreateVersion7(), Report).Should().BeFalse("o requestId tem de ser o do pedido");
        reports.Complete("pc-casa", ticket.RequestId, Report).Should().BeTrue();
        reports.Complete("pc-casa", ticket.RequestId, Report).Should().BeFalse("o segundo é repetido");
    }

    [Fact]
    public void OnlyOneRequestPerAgentAtATime_AndTheTurnComesBackOnDispose()
    {
        var reports = new InMemoryAgentLogReports(TimeProvider.System);
        var first = reports.TryBegin("pc-casa")!;

        reports.TryBegin("pc-casa").Should().BeNull();
        reports.TryBegin("outro").Should().NotBeNull("outro agente não disputa a vez");
        first.Dispose();
        reports.TryBegin("pc-casa").Should().NotBeNull();
        reports.Complete("pc-casa", first.RequestId, Report).Should().BeFalse("o pedido anterior já saiu");
    }

    [Fact]
    public async Task WithoutAReport_TheWaitEndsEmptyAfterTheGrace()
    {
        var reports = new InMemoryAgentLogReports(TimeProvider.System);
        using var ticket = reports.TryBegin("pc-casa")!;

        (await ticket.WaitAsync(TimeSpan.FromMilliseconds(50), TestContext.Current.CancellationToken)).Should().BeNull();
    }

    [Fact]
    public void TheNewMessageTypesAreDeclaredWithTheirDirection()
    {
        AgentMessageDirections.FromAgent.Should().Contain(AgentMessageTypes.AgentLogsV1);
        AgentMessageDirections.ToAgent.Should().Contain([AgentMessageTypes.AgentLogsRequestV1, AgentMessageTypes.AgentMaintenanceV1]);
        AgentMessageDirections.FromAgent.Should().NotContain([AgentMessageTypes.AgentLogsRequestV1, AgentMessageTypes.AgentMaintenanceV1]);
        AgentMessageDirections.ToAgent.Should().NotContain(AgentMessageTypes.AgentLogsV1);
    }
}
