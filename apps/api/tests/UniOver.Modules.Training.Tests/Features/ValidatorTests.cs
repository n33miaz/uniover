using AwesomeAssertions;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Features.Catalog.PullExercises;
using UniOver.Modules.Training.Features.Catalog.SetExerciseStep;
using UniOver.Modules.Training.Features.Catalog.UpsertCustomExercise;

namespace UniOver.Modules.Training.Tests.Features;

public class UpsertCustomExerciseValidatorTests
{
    private static readonly Guid UserId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid ExerciseId = Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ab");
    private static readonly DateTimeOffset Stamp = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private static UpsertCustomExerciseRequest Valid() => new(
        Name: "Meu supino",
        PrimaryMuscles: [Muscle.Chest],
        SecondaryMuscles: [Muscle.Triceps],
        Equipment: Equipment.Barbell,
        RecordType: ExerciseRecordTypes.WeightReps,
        StepKg: 2.5m,
        Instructions: ["Deite no banco."],
        ClientUpdatedAt: Stamp,
        Deleted: false);

    private static Dictionary<string, string[]> Run(UpsertCustomExerciseRequest? request, out UpsertCustomExerciseCommand? command, Guid? id = null) =>
        UpsertCustomExerciseValidator.Validate(id ?? ExerciseId, request, UserId, out command);

    [Fact]
    public void ValidRequest_BecomesANormalizedCommand()
    {
        var request = Valid() with { Name = "  Meu supino  ", Instructions = ["  Deite no banco.  "] };

        var errors = Run(request, out var command);

        errors.Should().BeEmpty();
        command.Should().NotBeNull();
        command!.Name.Should().Be("Meu supino");
        command.Instructions.Should().Equal("Deite no banco.");
        command.UserId.Should().Be(UserId);
        command.Id.Should().Be(ExerciseId);
    }

    [Fact]
    public void MissingBody_IsRefused()
    {
        Run(null, out var command).Should().ContainKey("body");
        command.Should().BeNull();
    }

    [Fact]
    public void EmptyId_IsRefused()
    {
        Run(Valid(), out _, Guid.Empty).Should().ContainKey("id");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void EmptyName_IsRefused(string? name)
    {
        Run(Valid() with { Name = name }, out _).Should().ContainKey("name");
    }

    [Fact]
    public void NameWithMoreThan120Characters_IsRefused()
    {
        Run(Valid() with { Name = new string('a', 121) }, out _).Should().ContainKey("name");
        Run(Valid() with { Name = new string('a', 120) }, out _).Should().BeEmpty();
    }

    [Fact]
    public void PrimaryMuscles_MustBeOneToThree_Distinct_AndFromTheTaxonomy()
    {
        Run(Valid() with { PrimaryMuscles = [] }, out _).Should().ContainKey("primaryMuscles");
        Run(Valid() with { PrimaryMuscles = null }, out _).Should().ContainKey("primaryMuscles");
        Run(Valid() with { PrimaryMuscles = [Muscle.Chest, Muscle.Triceps, Muscle.Biceps, Muscle.Lats] }, out _).Should().ContainKey("primaryMuscles");
        Run(Valid() with { PrimaryMuscles = [Muscle.Chest, Muscle.Chest] }, out _).Should().ContainKey("primaryMuscles");
        Run(Valid() with { PrimaryMuscles = ["pinky_toe"] }, out _).Should().ContainKey("primaryMuscles");
        Run(Valid() with { PrimaryMuscles = [Muscle.Chest, Muscle.Triceps, Muscle.Biceps] }, out _).Should().BeEmpty();
    }

    [Fact]
    public void SecondaryMuscles_MustBeDistinctAndFromTheTaxonomy()
    {
        Run(Valid() with { SecondaryMuscles = ["pinky_toe"] }, out _).Should().ContainKey("secondaryMuscles");
        Run(Valid() with { SecondaryMuscles = [Muscle.Triceps, Muscle.Triceps] }, out _).Should().ContainKey("secondaryMuscles");
        Run(Valid() with { SecondaryMuscles = null }, out var command).Should().BeEmpty();
        command!.SecondaryMuscles.Should().BeEmpty();
    }

    [Fact]
    public void Equipment_AndRecordType_MustBeFromTheClosedSets()
    {
        Run(Valid() with { Equipment = "kettlebell" }, out _).Should().ContainKey("equipment");
        Run(Valid() with { Equipment = null }, out _).Should().ContainKey("equipment");
        Run(Valid() with { RecordType = "distance" }, out _).Should().ContainKey("recordType");
        Run(Valid() with { RecordType = null }, out _).Should().ContainKey("recordType");
    }

    [Theory]
    [InlineData(-0.5)]
    [InlineData(1000.5)]
    [InlineData(2.345)]
    public void StepKg_OutOfRangeOrTooPrecise_IsRefused(double step)
    {
        Run(Valid() with { StepKg = (decimal)step }, out _).Should().ContainKey("stepKg");
    }

    [Fact]
    public void StepKg_NullZeroAndTheLimit_AreAccepted()
    {
        Run(Valid() with { StepKg = null }, out _).Should().BeEmpty();
        Run(Valid() with { StepKg = 0 }, out _).Should().BeEmpty();
        Run(Valid() with { StepKg = 1000 }, out _).Should().BeEmpty();
    }

    [Fact]
    public void Instructions_AreOptional_UpToTwentyItemsOfFiveHundredCharacters()
    {
        Run(Valid() with { Instructions = null }, out var command).Should().BeEmpty();
        command!.Instructions.Should().BeEmpty();

        Run(Valid() with { Instructions = [.. Enumerable.Repeat("passo", 20)] }, out _).Should().BeEmpty();
        Run(Valid() with { Instructions = [.. Enumerable.Repeat("passo", 21)] }, out _).Should().ContainKey("instructions");
        Run(Valid() with { Instructions = [new string('a', 501)] }, out _).Should().ContainKey("instructions");
        Run(Valid() with { Instructions = [new string('a', 500)] }, out _).Should().BeEmpty();
        Run(Valid() with { Instructions = [" "] }, out _).Should().ContainKey("instructions");
    }

    [Fact]
    public void ClientUpdatedAt_IsRequired()
    {
        Run(Valid() with { ClientUpdatedAt = null }, out _).Should().ContainKey("clientUpdatedAt");
        Run(Valid() with { ClientUpdatedAt = default(DateTimeOffset) }, out _).Should().ContainKey("clientUpdatedAt");
    }

    [Fact]
    public void ClientUpdatedAt_IsTruncatedToMicroseconds()
    {
        Run(Valid() with { ClientUpdatedAt = Stamp.AddTicks(7) }, out var command).Should().BeEmpty();

        command!.ClientUpdatedAt.Should().Be(Stamp);
    }
}

public class SetExerciseStepValidatorTests
{
    private static readonly Guid UserId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid ExerciseId = Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ab");
    private static readonly DateTimeOffset Stamp = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ValidRequest_BecomesACommand_AndNullStepMeansBackToTheEquipmentStep()
    {
        var errors = SetExerciseStepValidator.Validate(ExerciseId, new SetExerciseStepRequest(null, Stamp), UserId, out var command);

        errors.Should().BeEmpty();
        command!.StepKg.Should().BeNull();
        command.ExerciseId.Should().Be(ExerciseId);
    }

    [Fact]
    public void MissingBody_AndMissingClock_AreRefused()
    {
        SetExerciseStepValidator.Validate(ExerciseId, null, UserId, out _).Should().ContainKey("body");
        SetExerciseStepValidator.Validate(ExerciseId, new SetExerciseStepRequest(2m, null), UserId, out _).Should().ContainKey("clientUpdatedAt");
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(1001)]
    [InlineData(1.234)]
    public void StepOutOfRange_IsRefused(double step)
    {
        SetExerciseStepValidator.Validate(ExerciseId, new SetExerciseStepRequest((decimal)step, Stamp), UserId, out _)
            .Should().ContainKey("stepKg");
    }
}

public class PullExercisesValidatorTests
{
    [Fact]
    public void Defaults_StartFromTheBeginningWithTwoHundred()
    {
        var errors = PullExercisesValidator.Validate(null, null, out var cursor, out var pageSize);

        errors.Should().BeEmpty();
        cursor.Should().BeNull();
        pageSize.Should().Be(200);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(501)]
    [InlineData(-3)]
    public void LimitOutsideOneToFiveHundred_IsRefused(int limit)
    {
        PullExercisesValidator.Validate(null, limit, out _, out _).Should().ContainKey("limit");
    }

    [Fact]
    public void LimitOfFiveHundred_IsAccepted()
    {
        PullExercisesValidator.Validate(null, 500, out _, out var pageSize).Should().BeEmpty();
        pageSize.Should().Be(500);
    }

    [Fact]
    public void InvalidCursor_IsRefused()
    {
        PullExercisesValidator.Validate("lixo", null, out _, out _).Should().ContainKey("after");
    }

    [Fact]
    public void ValidCursor_IsDecoded()
    {
        var text = new PullCursor(DateTimeOffset.UtcNow, Guid.NewGuid()).Encode();

        PullExercisesValidator.Validate(text, null, out var cursor, out _).Should().BeEmpty();
        cursor.Should().NotBeNull();
    }
}
