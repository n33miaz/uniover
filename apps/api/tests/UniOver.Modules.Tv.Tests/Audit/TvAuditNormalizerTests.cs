using System.Reflection;
using AwesomeAssertions;
using UniOver.Modules.Tv.Audit;
using UniOver.Modules.Tv.Domain;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Tv.Tests.Audit;

public class TvAuditNormalizerTests
{
    private static readonly DateTimeOffset At = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
    private static readonly Guid User = Guid.Parse("11111111-1111-7111-8111-111111111111");
    private static readonly ClientInfo Client = new("203.0.113.7", "navegador/1.0");

    [Fact]
    public void ADeliveredCommand_IsASuccess_WithTheKeyAsTarget()
    {
        var entry = CommandAuditEntry.Create(User, "pc-casa", TvCommandNames.Key, "VOLUME_UP", true, null, 120, Client, At);

        var record = TvAuditNormalizer.Normalize(entry);

        record.Id.Should().Be(entry.Id);
        record.Module.Should().Be("tv");
        record.Action.Should().Be("tv.key");
        record.ActorId.Should().Be(User);
        record.Target.Should().Be("VOLUME_UP");
        record.Outcome.Should().Be(AuditOutcome.Success);
        record.Detail.Should().BeNull();
        record.Ip.Should().Be("203.0.113.7");
        record.UserAgent.Should().Be("navegador/1.0");
        record.OccurredAt.Should().Be(At);
    }

    [Fact]
    public void AFailedCommand_IsAFailure_AndTheErrorCodeIsTheDetail()
    {
        var entry = CommandAuditEntry.Create(User, "pc-casa", TvCommandNames.AppLaunch, "com.exemplo.app", false, "AgentOffline", null, Client, At);

        var record = TvAuditNormalizer.Normalize(entry);

        record.Outcome.Should().Be(AuditOutcome.Failure);
        record.Target.Should().Be("com.exemplo.app");
        record.Detail.Should().Be("AgentOffline");
    }

    [Fact]
    public void TypedText_AppearsOnlyAsItsLength()
    {
        // Quem grava a linha só entrega o tamanho; a normalização repassa exatamente isso.
        var entry = CommandAuditEntry.Create(User, "pc-casa", TvCommandNames.Text, "length=12", true, null, 80, Client, At);

        var record = TvAuditNormalizer.Normalize(entry);

        record.Target.Should().Be("length=12");
    }

    [Fact]
    public void EveryCommandName_IsListedOnce()
    {
        var declared = typeof(TvCommandNames)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.IsLiteral)
            .Select(f => (string)f.GetRawConstantValue()!)
            .ToList();

        TvAuditNormalizer.Actions.Should().OnlyHaveUniqueItems();
        TvAuditNormalizer.Actions.Should().BeEquivalentTo(declared, "um comando novo precisa entrar na lista que a tela e o filtro usam");
        TvAuditNormalizer.Actions.Should().OnlyContain(a => a.Length <= CommandAuditEntry.CommandMax);
    }
}
