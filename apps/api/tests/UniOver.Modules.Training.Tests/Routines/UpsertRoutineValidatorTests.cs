using AwesomeAssertions;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Features.Routines.PullRoutines;
using UniOver.Modules.Training.Features.Routines.UpsertRoutine;

namespace UniOver.Modules.Training.Tests.Routines;

public class UpsertRoutineValidatorTests
{
    private static readonly Guid UserId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid RoutineId = Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ab");
    private static readonly DateTimeOffset Stamp = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private static UpsertRoutineItemRequest Item(int position = 0) => new(
        Id: Guid.NewGuid(),
        ExerciseId: Guid.NewGuid(),
        Position: position,
        TargetSets: 3,
        RepMin: 8,
        RepMax: 12,
        RestSeconds: 90,
        SupersetGroup: null,
        Note: null);

    private static UpsertRoutineRequest Valid() => new(
        Name: "A · Peito",
        Position: 0,
        Active: true,
        Note: null,
        Items: [Item(0), Item(1)],
        ClientUpdatedAt: Stamp,
        Deleted: false);

    private static Dictionary<string, string[]> Run(UpsertRoutineRequest? request, out UpsertRoutineCommand? command, Guid? id = null) =>
        UpsertRoutineValidator.Validate(id ?? RoutineId, request, UserId, out command);

    [Fact]
    public void ValidRequest_BecomesANormalizedCommand()
    {
        var request = Valid() with { Name = "  A · Peito  ", Note = "  foco na carga  " };

        var errors = Run(request, out var command);

        errors.Should().BeEmpty();
        command.Should().NotBeNull();
        command!.Name.Should().Be("A · Peito");
        command.Note.Should().Be("foco na carga");
        command.UserId.Should().Be(UserId);
        command.Id.Should().Be(RoutineId);
        command.Items.Should().HaveCount(2);
    }

    [Fact]
    public void BlankNote_BecomesNull()
    {
        Run(Valid() with { Note = "   " }, out var command).Should().BeEmpty();

        command!.Note.Should().BeNull();
    }

    [Fact]
    public void MissingBody_IsRefused()
    {
        Run(null, out var command).Should().ContainKey("body");
        command.Should().BeNull();
    }

    [Fact]
    public void EmptyId_IsRefused() => Run(Valid(), out _, Guid.Empty).Should().ContainKey("id");

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void EmptyName_IsRefused(string? name) => Run(Valid() with { Name = name }, out _).Should().ContainKey("name");

    [Fact]
    public void NameWith80Characters_IsAccepted_And81IsRefused()
    {
        Run(Valid() with { Name = new string('a', RoutineLimits.NameMax) }, out _).Should().BeEmpty();
        Run(Valid() with { Name = new string('a', RoutineLimits.NameMax + 1) }, out _).Should().ContainKey("name");
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(1001)]
    public void PositionOutOfRange_IsRefused(int position) =>
        Run(Valid() with { Position = position }, out _).Should().ContainKey("position");

    [Fact]
    public void MissingActive_IsRefused() => Run(Valid() with { Active = null }, out _).Should().ContainKey("active");

    [Fact]
    public void NoteOver500Characters_IsRefused() =>
        Run(Valid() with { Note = new string('x', 501) }, out _).Should().ContainKey("note");

    [Fact]
    public void MissingClock_IsRefused()
    {
        Run(Valid() with { ClientUpdatedAt = null }, out _).Should().ContainKey("clientUpdatedAt");
        Run(Valid() with { ClientUpdatedAt = default(DateTimeOffset) }, out _).Should().ContainKey("clientUpdatedAt");
    }

    [Fact]
    public void FortyItems_AreAccepted_AndFortyOneAreRefused()
    {
        var forty = Enumerable.Range(0, 40).Select(Item).ToList();

        Run(Valid() with { Items = forty }, out _).Should().BeEmpty();
        Run(Valid() with { Items = [.. forty, Item(40)] }, out _).Should().ContainKey("items");
    }

    [Fact]
    public void MissingItems_AreRefused_ButAnEmptyRoutineIsValid()
    {
        Run(Valid() with { Items = null }, out _).Should().ContainKey("items");
        Run(Valid() with { Items = [] }, out _).Should().BeEmpty();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(21)]
    public void SetsOutOfRange_AreRefused(int sets) =>
        Run(Valid() with { Items = [Item() with { TargetSets = sets }] }, out _).Should().ContainKey("items[0]");

    [Theory]
    [InlineData(0, 10)]
    [InlineData(8, 101)]
    [InlineData(12, 8)]
    public void RepRangeOutOfRange_IsRefused(int min, int max) =>
        Run(Valid() with { Items = [Item() with { RepMin = min, RepMax = max }] }, out _).Should().ContainKey("items[0]");

    [Fact]
    public void EqualRepMinAndMax_IsAccepted() =>
        Run(Valid() with { Items = [Item() with { RepMin = 10, RepMax = 10 }] }, out _).Should().BeEmpty();

    [Theory]
    [InlineData(-1)]
    [InlineData(1801)]
    public void RestOutOfRange_IsRefused(int rest) =>
        Run(Valid() with { Items = [Item() with { RestSeconds = rest }] }, out _).Should().ContainKey("items[0]");

    [Fact]
    public void ZeroRest_AndTheMaximumRest_AreAccepted()
    {
        Run(Valid() with { Items = [Item() with { RestSeconds = 0 }] }, out _).Should().BeEmpty();
        Run(Valid() with { Items = [Item() with { RestSeconds = 1800 }] }, out _).Should().BeEmpty();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(101)]
    public void SupersetGroupOutOfRange_IsRefused(int group) =>
        Run(Valid() with { Items = [Item() with { SupersetGroup = group }] }, out _).Should().ContainKey("items[0]");

    [Fact]
    public void ItemWithoutIdOrExercise_IsRefused()
    {
        Run(Valid() with { Items = [Item() with { Id = null }] }, out _).Should().ContainKey("items[0]");
        Run(Valid() with { Items = [Item() with { ExerciseId = Guid.Empty }] }, out _).Should().ContainKey("items[0]");
    }

    [Fact]
    public void RepeatedItemId_IsRefused()
    {
        var first = Item(0);

        Run(Valid() with { Items = [first, Item(1) with { Id = first.Id }] }, out _).Should().ContainKey("items[1]");
    }

    [Fact]
    public void ItemNoteOver300Characters_IsRefused() =>
        Run(Valid() with { Items = [Item() with { Note = new string('x', 301) }] }, out _).Should().ContainKey("items[0]");

    [Fact]
    public void ADeletedRoutine_IgnoresTheItemsInTheBody()
    {
        var request = Valid() with { Deleted = true, Items = [Item() with { TargetSets = 99 }] };

        var errors = Run(request, out var command);

        errors.Should().BeEmpty();
        command!.Items.Should().BeEmpty();
        command.Deleted.Should().BeTrue();
    }

    [Fact]
    public void TheClockIsTruncatedToTheDatabasePrecision()
    {
        var stamp = Stamp.AddTicks(7);

        Run(Valid() with { ClientUpdatedAt = stamp }, out var command).Should().BeEmpty();

        command!.ClientUpdatedAt.UtcTicks.Should().Be(stamp.UtcTicks - (stamp.UtcTicks % 10));
    }
}

public class PullRoutinesValidatorTests
{
    [Fact]
    public void Defaults_AreTheCommonPullPage()
    {
        PullRoutinesValidator.Validate(null, null, out var cursor, out var size).Should().BeEmpty();

        cursor.Should().BeNull();
        size.Should().Be(200);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(501)]
    public void LimitOutOfRange_IsRefused(int limit) =>
        PullRoutinesValidator.Validate(null, limit, out _, out _).Should().ContainKey("limit");

    [Fact]
    public void GarbageCursor_IsRefused() =>
        PullRoutinesValidator.Validate("lixo", null, out _, out _).Should().ContainKey("after");

    [Fact]
    public void ValidCursor_IsDecoded()
    {
        var original = new PullCursor(new DateTimeOffset(2026, 10, 19, 12, 0, 0, TimeSpan.Zero), Guid.NewGuid());

        PullRoutinesValidator.Validate(original.Encode(), 10, out var cursor, out var size).Should().BeEmpty();

        cursor.Should().Be(original);
        size.Should().Be(10);
    }
}
