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
    public void TheShortcutTheScreenReceives_SeparatesWhatIsOnTheRemoteFromWhatIsInstalled()
    {
        var (list, _) = ShortcutCatalog.Merge([], [new IncomingApp("a.um", "Um")], Now);
        var shortcut = list.Single();

        TvShortcut.From(shortcut).Should().Match<TvShortcut>(s => s.Enabled && s.Installed);

        // O dono tirou o app do controle: segue instalado (e, por isso, aberto pelo painel Apps).
        shortcut.SetEnabled(false, Now);
        TvShortcut.From(shortcut).Should().Match<TvShortcut>(s => !s.Enabled && s.Installed);

        // O app saiu da TV: nem instalado nem no controle, mesmo que o dono o tenha fixado antes.
        shortcut.SetEnabled(true, Now);
        ShortcutCatalog.Merge(list, [new IncomingApp("b.dois", "Dois")], Now);
        TvShortcut.From(shortcut).Should().Match<TvShortcut>(s => !s.Enabled && !s.Installed);
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

    private static List<Shortcut> Catalog(params string[] packages)
    {
        var (list, _) = ShortcutCatalog.Merge([], [.. packages.Select(p => new IncomingApp(p, p))], Now);
        return [.. list];
    }

    private static Guid[] IdsOf(IReadOnlyList<Shortcut> list, params string[] packagesInOrder) =>
        [.. packagesInOrder.Select(p => list.Single(s => s.Package == p).Id)];

    private static string[] InOrder(IEnumerable<Shortcut> list) => [.. list.OrderBy(s => s.Position).Select(s => s.Package)];

    [Fact]
    public void Reorder_PutsEveryShortcutInTheGivenOrder_NumberedFromOneToN()
    {
        var list = Catalog("a.um", "b.dois", "c.tres", "d.quatro");
        var later = Now.AddMinutes(5);

        var ok = ShortcutCatalog.TryReorder(list, IdsOf(list, "c.tres", "a.um", "d.quatro", "b.dois"), later, out var changed);

        ok.Should().BeTrue();
        changed.Should().BeTrue();
        InOrder(list).Should().Equal("c.tres", "a.um", "d.quatro", "b.dois");
        list.OrderBy(s => s.Position).Select(s => s.Position).Should().Equal(1, 2, 3, 4);
    }

    [Fact]
    public void Reorder_TouchesOnlyTheShortcutsThatMoved()
    {
        var list = Catalog("a.um", "b.dois", "c.tres");
        var later = Now.AddMinutes(5);

        // Só o "c" e o "b" trocam de lugar: o "a" fica como estava, inclusive no UpdatedAt.
        ShortcutCatalog.TryReorder(list, IdsOf(list, "a.um", "c.tres", "b.dois"), later, out _);

        list.Single(s => s.Package == "a.um").UpdatedAt.Should().Be(Now);
        list.Single(s => s.Package == "b.dois").UpdatedAt.Should().Be(later);
        list.Single(s => s.Package == "c.tres").UpdatedAt.Should().Be(later);
    }

    [Fact]
    public void Reorder_WithTheOrderThatAlreadyExists_IsValidButChangesNothing()
    {
        var list = Catalog("a.um", "b.dois");

        var ok = ShortcutCatalog.TryReorder(list, IdsOf(list, "a.um", "b.dois"), Now.AddMinutes(5), out var changed);

        ok.Should().BeTrue();
        changed.Should().BeFalse();
        list.Should().OnlyContain(s => s.UpdatedAt == Now);
    }

    [Fact]
    public void Reorder_IncludesTheOnesOutOfTheControlAndTheOnesThatLeftTheTv()
    {
        var list = Catalog("a.um", "b.dois", "c.tres");
        list[1].SetEnabled(false, Now);
        ShortcutCatalog.Merge(list, [new IncomingApp("a.um", "a.um"), new IncomingApp("b.dois", "b.dois")], Now);
        list[2].IsActive.Should().BeFalse("o c saiu da TV");

        ShortcutCatalog.TryReorder(list, IdsOf(list, "c.tres", "b.dois", "a.um"), Now.AddMinutes(1), out _).Should().BeTrue();

        InOrder(list).Should().Equal("c.tres", "b.dois", "a.um");
        list.Single(s => s.Package == "b.dois").IsActive.Should().BeFalse("a ordem não muda quem está no controle");
    }

    [Fact]
    public void Reorder_NormalizesPositionsThatHadGaps()
    {
        // Mesmo com a ordem igual, posições 1 e 3 passam a ser 1 e 2.
        List<Shortcut> list = [Shortcut.Create("a.um", "a.um", 1, Now), Shortcut.Create("b.dois", "b.dois", 3, Now)];

        ShortcutCatalog.TryReorder(list, IdsOf(list, "a.um", "b.dois"), Now.AddMinutes(1), out var changed).Should().BeTrue();

        changed.Should().BeTrue();
        list.Select(s => s.Position).Should().Equal(1, 2);
    }

    [Fact]
    public void Reorder_RefusesAnythingThatIsNotAnExactPermutation_AndTouchesNothing()
    {
        var list = Catalog("a.um", "b.dois", "c.tres");
        var all = IdsOf(list, "a.um", "b.dois", "c.tres");
        var before = list.Select(s => (s.Id, s.Position, s.UpdatedAt)).ToList();
        var later = Now.AddMinutes(5);

        var invalid = new (string Why, Guid[] Ids)[]
        {
            ("falta um", [all[2], all[0]]),
            ("sobra um desconhecido", [all[2], all[0], all[1], Guid.NewGuid()]),
            ("um desconhecido no lugar de um", [all[2], Guid.NewGuid(), all[0]]),
            ("repetido", [all[2], all[2], all[0]]),
            ("vazia", []),
        };

        foreach (var (why, ids) in invalid)
        {
            ShortcutCatalog.TryReorder(list, ids, later, out var changed).Should().BeFalse(why);
            changed.Should().BeFalse(why);
        }

        list.Select(s => (s.Id, s.Position, s.UpdatedAt)).Should().Equal(before, "nenhuma recusa grava meia ordem");
    }

    [Fact]
    public void Reorder_OnAnEmptyCatalog_AcceptsTheEmptyList()
    {
        ShortcutCatalog.TryReorder([], [], Now, out var changed).Should().BeTrue();
        changed.Should().BeFalse();
    }

    [Fact]
    public void ANewListFromTheAgent_KeepsTheOwnersOrder_PutsNewAppsAtTheEnd_AndAnAppThatCameBackKeepsItsSlot()
    {
        var list = Catalog("a.um", "b.dois", "c.tres");
        ShortcutCatalog.TryReorder(list, IdsOf(list, "c.tres", "a.um", "b.dois"), Now.AddMinutes(1), out _);

        // "a.um" sai da TV, e chega uma lista com um app novo e os outros dois em outra ordem.
        var (added, _) = ShortcutCatalog.Merge(
            list, [new IncomingApp("z.novo", "Novo"), new IncomingApp("b.dois", "b.dois"), new IncomingApp("c.tres", "c.tres")], Now.AddMinutes(2));
        list.AddRange(added);

        added.Should().ContainSingle().Which.Position.Should().Be(4);
        InOrder(list).Should().Equal("c.tres", "a.um", "b.dois", "z.novo");

        // "a.um" volta: no mesmo lugar que o dono lhe deu, não no fim.
        ShortcutCatalog.Merge(list, [.. list.Select(s => new IncomingApp(s.Package, s.Package))], Now.AddMinutes(3));
        InOrder(list).Should().Equal("c.tres", "a.um", "b.dois", "z.novo");
        list.Single(s => s.Package == "a.um").IsActive.Should().BeTrue();
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
