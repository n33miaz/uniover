using AwesomeAssertions;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;

namespace UniOver.Modules.Training.Tests.Routines;

public class RoutineRulesTests
{
    private static RoutineItemSpec Item(int position, int? group = null) => new(
        Guid.NewGuid(),
        Guid.NewGuid(),
        position,
        TargetSets: 3,
        RepMin: 8,
        RepMax: 12,
        RestSeconds: 90,
        SupersetGroup: group,
        Note: null);

    [Fact]
    public void Arrange_SortsByPosition_AndRecompactsFromZero()
    {
        var a = Item(30);
        var b = Item(5);
        var c = Item(17);

        var arranged = RoutineRules.Arrange([a, b, c]);

        arranged.Select(i => i.Id).Should().Equal(b.Id, c.Id, a.Id);
        arranged.Select(i => i.Position).Should().Equal(0, 1, 2);
    }

    [Fact]
    public void Arrange_KeepsTheArrivalOrder_WhenPositionsTie()
    {
        var a = Item(2);
        var b = Item(2);
        var c = Item(2);

        RoutineRules.Arrange([a, b, c]).Select(i => i.Id).Should().Equal(a.Id, b.Id, c.Id);
    }

    [Fact]
    public void Arrange_OfAnEmptyList_IsEmpty()
    {
        RoutineRules.Arrange([]).Should().BeEmpty();
    }

    [Fact]
    public void Supersets_AreContiguous_WhenTheGroupIsAnUninterruptedRun()
    {
        var items = RoutineRules.Arrange([Item(0), Item(1, 1), Item(2, 1), Item(3), Item(4, 2), Item(5, 2), Item(6, 2)]);

        RoutineRules.SupersetsAreContiguous(items).Should().BeTrue();
    }

    [Fact]
    public void Supersets_AreNotContiguous_WhenAnotherItemSitsBetweenTwoOfTheSameGroup()
    {
        var items = RoutineRules.Arrange([Item(0, 1), Item(1), Item(2, 1)]);

        RoutineRules.SupersetsAreContiguous(items).Should().BeFalse();
    }

    [Fact]
    public void Supersets_AreNotContiguous_WhenTheGroupReturnsAfterAnotherGroup()
    {
        var items = RoutineRules.Arrange([Item(0, 1), Item(1, 2), Item(2, 1)]);

        RoutineRules.SupersetsAreContiguous(items).Should().BeFalse();
    }

    [Fact]
    public void Supersets_ContiguityIsJudgedByTheSortedOrder_NotByTheArrayOrder()
    {
        // No array os itens do grupo 1 estão separados, mas pela posição eles são vizinhos.
        var items = RoutineRules.Arrange([Item(1, 1), Item(0), Item(2, 1)]);

        items.Select(i => i.SupersetGroup).Should().Equal(null, 1, 1);
        RoutineRules.SupersetsAreContiguous(items).Should().BeTrue();
    }

    [Fact]
    public void NormalizeSupersets_TurnsALoneGroupIntoNoGroup_AndKeepsRealPairs()
    {
        var items = RoutineRules.Arrange([Item(0, 4), Item(1, 1), Item(2, 1), Item(3), Item(4, 7)]);

        var normalized = RoutineRules.NormalizeSupersets(items);

        normalized.Select(i => i.SupersetGroup).Should().Equal(null, 1, 1, null, null);
    }

    [Fact]
    public void LastWriter_TheNewerTombstoneBeatsAnOlderEdit_AndTheOlderOneDoesNot()
    {
        var edit = new DateTimeOffset(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

        LastWriterWins.ShouldApply(edit.AddMinutes(1), edit).Should().BeTrue("a lápide mais nova vence");
        LastWriterWins.ShouldApply(edit.AddMinutes(-1), edit).Should().BeFalse("a escrita mais velha é ignorada");
        LastWriterWins.ShouldApply(edit, edit).Should().BeTrue("o reenvio do mesmo instante aplica de novo");
        LastWriterWins.IsClockAhead(edit.AddHours(25), edit).Should().BeTrue();
    }
}
