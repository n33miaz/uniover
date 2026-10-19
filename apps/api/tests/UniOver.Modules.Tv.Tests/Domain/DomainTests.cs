using AwesomeAssertions;
using UniOver.Modules.Tv.Domain;

namespace UniOver.Modules.Tv.Tests.Domain;

public class DomainTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private static TvStateSnapshot Snapshot(string power = "on", int? volume = 10, string? app = "tv.app", string connection = "hot") =>
        new(power, volume, app, connection, Now);

    [Fact]
    public void ChangingOnlyTheVolume_IsNotAPersistedChange()
    {
        Snapshot(volume: 10).SamePersistedFieldsAs(Snapshot(volume: 55)).Should().BeTrue();
    }

    [Theory]
    [InlineData("off", "tv.app", "hot")]
    [InlineData("on", "outro.app", "hot")]
    [InlineData("on", null, "hot")]
    [InlineData("on", "tv.app", "hibernating")]
    public void ChangingPowerAppOrConnection_IsAPersistedChange(string power, string? app, string connection)
    {
        Snapshot().SamePersistedFieldsAs(Snapshot(power: power, app: app, connection: connection)).Should().BeFalse();
    }

    [Fact]
    public void ComparingWithNothingStored_IsAChange()
    {
        Snapshot().SamePersistedFieldsAs(null).Should().BeFalse();
    }

    [Fact]
    public void StoredRow_MatchesTheSameStateEvenWhenTheAppIsTooLongToStore_AndIgnoresTheVolume()
    {
        var longApp = new string('p', 300);
        var record = TvStateRecord.Create("pc-casa", Snapshot(app: longApp, volume: 5));

        record.Matches(Snapshot(app: longApp, volume: 99)).Should().BeTrue();
        record.Matches(Snapshot(app: longApp, power: "off")).Should().BeFalse();
        record.Matches(Snapshot(app: "outro")).Should().BeFalse();
    }

    [Fact]
    public void State_WithoutAnAgent_ReportsDisconnected_AndHidesTheStaleVolume()
    {
        var state = TvState.From(Snapshot(volume: 33), agentOnline: false);

        state.Connection.Should().Be("disconnected");
        state.AgentOnline.Should().BeFalse();
        state.Volume.Should().BeNull();
        state.Power.Should().Be("on");
    }

    [Fact]
    public void State_WithTheAgentOnline_KeepsWhatTheAgentSaid()
    {
        var state = TvState.From(Snapshot(volume: 33, connection: "hibernating"), agentOnline: true);

        state.Connection.Should().Be("hibernating");
        state.Volume.Should().Be(33);
        state.AgentOnline.Should().BeTrue();
    }

    [Fact]
    public void State_BeforeAnyReport_IsUnknown()
    {
        var state = TvState.From(null, agentOnline: true);

        state.Power.Should().Be("unknown");
        state.Connection.Should().Be("disconnected");
        state.UpdatedAt.Should().BeNull();
    }

    [Fact]
    public void Merge_OnAnEmptyCatalog_CreatesShortcutsByPositionInTheOrderTheTvGave()
    {
        var (added, changed) = ShortcutCatalog.Merge(
            [], [new IncomingApp("a.um", "Um"), new IncomingApp("b.dois", null), new IncomingApp("c.tres", "Três")], Now);

        changed.Should().BeTrue();
        added.Select(s => (s.Package, s.Position)).Should().Equal(("a.um", 1), ("b.dois", 2), ("c.tres", 3));
        added.Select(s => s.TvLabel).Should().Equal("Um", null, "Três");
        added.Should().OnlyContain(s => s.IsActive && s.CustomLabel == null);
    }

    [Fact]
    public void Merge_KeepsTheOwnersLabelAndPosition_AndUpdatesOnlyTheTvLabel()
    {
        var (first, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um"), new IncomingApp("b.dois", "Dois")], Now);
        first[0].SetCustomLabel("Meu app", Now);

        // A TV passa a listar em outra ordem e com o rótulo de um app mudado.
        var (added, changed) = ShortcutCatalog.Merge(first, [new IncomingApp("b.dois", "Dois novo"), new IncomingApp("a.um", "Um")], Now);

        added.Should().BeEmpty();
        changed.Should().BeTrue();
        first[0].CustomLabel.Should().Be("Meu app");
        first[0].Position.Should().Be(1);
        first[1].Position.Should().Be(2);
        first[1].TvLabel.Should().Be("Dois novo");
    }

    [Fact]
    public void Merge_AppsThatVanished_AreKeptButInactive_AndComeBackInTheSamePlace()
    {
        var (first, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um"), new IncomingApp("b.dois", "Dois")], Now);

        ShortcutCatalog.Merge(first, [new IncomingApp("a.um", "Um")], Now);
        first.Single(s => s.Package == "b.dois").IsActive.Should().BeFalse();
        first.Should().HaveCount(2, "nada é apagado");

        var (added, _) = ShortcutCatalog.Merge(first, [new IncomingApp("a.um", "Um"), new IncomingApp("b.dois", "Dois")], Now);
        added.Should().BeEmpty();
        first.Single(s => s.Package == "b.dois").IsActive.Should().BeTrue();
        first.Single(s => s.Package == "b.dois").Position.Should().Be(2);
    }

    [Fact]
    public void Merge_NewAppsGoToTheEnd_WithoutRenumberingAnyone()
    {
        var (first, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um"), new IncomingApp("b.dois", "Dois")], Now);

        var (added, _) = ShortcutCatalog.Merge(first, [new IncomingApp("z.novo", "Novo"), new IncomingApp("a.um", "Um")], Now);

        added.Should().ContainSingle().Which.Position.Should().Be(3);
        first.Select(s => s.Position).Should().Equal(1, 2);
    }

    [Fact]
    public void Merge_AnAppTheOwnerHid_StaysHiddenAfterANewList()
    {
        var (first, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um")], Now);
        first[0].SetEnabled(false, Now);

        ShortcutCatalog.Merge(first, [new IncomingApp("a.um", "Um")], Now);

        first[0].IsActive.Should().BeFalse();
    }

    [Fact]
    public void Merge_IgnoresARepeatedPackage()
    {
        var (added, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um"), new IncomingApp("a.um", "Outro")], Now);

        added.Should().ContainSingle().Which.TvLabel.Should().Be("Um");
    }

    [Fact]
    public void CustomLabel_BlankClearsIt_AndIsTrimmed()
    {
        var (list, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um")], Now);

        list[0].SetCustomLabel("  Streaming  ", Now);
        list[0].CustomLabel.Should().Be("Streaming");
        list[0].SetCustomLabel("   ", Now);
        list[0].CustomLabel.Should().BeNull();
    }

    [Fact]
    public void Audit_TruncatesWhatTheClientControls()
    {
        var entry = CommandAuditEntry.Create(
            Guid.NewGuid(), "pc", "tv.key", "OK", true, null, 12,
            new ClientInfo(new string('1', 100), new string('u', 500)), Now);

        entry.Ip!.Length.Should().Be(CommandAuditEntry.IpMax);
        entry.UserAgent!.Length.Should().Be(CommandAuditEntry.UserAgentMax);
    }
}
