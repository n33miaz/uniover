using System.Reflection;
using AwesomeAssertions;
using UniOver.Modules.Devices.Audit;
using UniOver.Modules.Devices.Domain;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Devices.Tests.Audit;

public class DevicesAuditNormalizerTests
{
    private static readonly DateTimeOffset At = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
    private static readonly Guid Admin = Guid.Parse("11111111-1111-7111-8111-111111111111");
    private static readonly Guid Agent = Guid.Parse("22222222-2222-7222-8222-222222222222");
    private static readonly Guid Pairing = Guid.Parse("33333333-3333-7333-8333-333333333333");

    [Theory]
    [InlineData(PairingEvents.Started, "pairing_started", AuditOutcome.Success)]
    [InlineData(PairingEvents.Approved, "pairing_approved", AuditOutcome.Success)]
    [InlineData(PairingEvents.Denied, "pairing_denied", AuditOutcome.Denied)]
    [InlineData(PairingEvents.Expired, "pairing_expired", AuditOutcome.Failure)]
    [InlineData(PairingEvents.TokenIssued, "pairing_token_issued", AuditOutcome.Success)]
    [InlineData(PairingEvents.AgentRevoked, "agent_revoked", AuditOutcome.Success)]
    [InlineData(PairingEvents.AgentLogsViewed, "agent_logs_viewed", AuditOutcome.Success)]
    [InlineData(PairingEvents.AgentUpdateRequested, "agent_update_requested", AuditOutcome.Success)]
    [InlineData(PairingEvents.AgentRestartRequested, "agent_restart_requested", AuditOutcome.Success)]
    [InlineData(PairingEvents.AgentRollbackRequested, "agent_rollback_requested", AuditOutcome.Success)]
    public void EachStoredEvent_BecomesAnUnambiguousActionWithAnOutcome(string stored, string action, AuditOutcome outcome)
    {
        var record = DevicesAuditNormalizer.Normalize(
            PairingAuditEntry.Create(stored, Agent, Pairing, Admin, "203.0.113.7", "agente/1.0", At), "Computador da sala");

        record.Module.Should().Be("devices");
        record.Action.Should().Be(action);
        record.Outcome.Should().Be(outcome);
        DevicesAuditActions.ToStored(action).Should().Be(stored, "o filtro por ação volta ao valor gravado");
    }

    [Fact]
    public void TheStoredEventsOfTheTable_AreAllMapped()
    {
        var stored = typeof(PairingEvents)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.IsLiteral)
            .Select(f => (string)f.GetRawConstantValue()!)
            .ToList();

        stored.Select(DevicesAuditActions.ToAction).Should().BeEquivalentTo(DevicesAuditActions.All);
        DevicesAuditActions.All.Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void Normalize_CarriesActorDeviceNameIpAndPairing()
    {
        var entry = PairingAuditEntry.Create(PairingEvents.Approved, Agent, Pairing, Admin, "203.0.113.7", "agente/1.0", At);

        var record = DevicesAuditNormalizer.Normalize(entry, "Computador da sala");

        record.Id.Should().Be(entry.Id);
        record.OccurredAt.Should().Be(At);
        record.ActorId.Should().Be(Admin);
        record.Target.Should().Be("Computador da sala");
        record.Detail.Should().Be(Pairing.ToString("N"));
        record.Ip.Should().Be("203.0.113.7");
        record.UserAgent.Should().Be("agente/1.0");
        record.TargetUserId.Should().BeNull();
    }

    [Fact]
    public void AgentSteps_HaveNoActor_AndAnUnknownAgentHasNoName()
    {
        var record = DevicesAuditNormalizer.Normalize(
            PairingAuditEntry.Create(PairingEvents.Started, null, Pairing, null, null, null, At), null);

        record.ActorId.Should().BeNull();
        record.Target.Should().BeNull();
        record.Ip.Should().BeNull();
    }

    [Fact]
    public void AStoredValueTheCodeDoesNotKnow_PassesThroughInsteadOfVanishing()
    {
        DevicesAuditActions.ToAction("algo_novo").Should().Be("algo_novo");
        DevicesAuditActions.ToStored("algo_novo").Should().BeNull();
    }
}
