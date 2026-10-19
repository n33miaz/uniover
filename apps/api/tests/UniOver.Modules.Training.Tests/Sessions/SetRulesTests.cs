using AwesomeAssertions;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain.Sessions;

namespace UniOver.Modules.Training.Tests.Sessions;

public class SetRulesTests
{
    [Theory]
    [InlineData(SetTypes.Work, 80.0, 8, true)]
    [InlineData(SetTypes.Work, null, 8, false)]
    [InlineData(SetTypes.Work, 80.0, null, false)]
    [InlineData(SetTypes.Warmup, null, 12, true)]
    [InlineData(SetTypes.Warmup, null, null, false)]
    [InlineData(SetTypes.Failure, null, 6, true)]
    [InlineData(SetTypes.Drop, 40.0, 10, true)]
    public void WeightReps_NeedsRepsAndTheLoadOnWorkSets(string setType, double? weight, int? reps, bool expected) =>
        SetRules.HasValidShape(ExerciseRecordTypes.WeightReps, setType, (decimal?)weight, reps, null).Should().Be(expected);

    [Theory]
    [InlineData(10, true)]
    [InlineData(null, false)]
    public void RepsOnly_NeedsReps(int? reps, bool expected) =>
        SetRules.HasValidShape(ExerciseRecordTypes.RepsOnly, SetTypes.Work, null, reps, null).Should().Be(expected);

    [Theory]
    [InlineData(45, true)]
    [InlineData(null, false)]
    public void Time_NeedsTheDuration(int? duration, bool expected) =>
        SetRules.HasValidShape(ExerciseRecordTypes.Time, SetTypes.Work, null, null, duration).Should().Be(expected);

    [Fact]
    public void TimeWithOnlyReps_IsInvalid() =>
        SetRules.HasValidShape(ExerciseRecordTypes.Time, SetTypes.Work, 10m, 10, null).Should().BeFalse();

    [Fact]
    public void UnknownRecordType_IsInvalid() =>
        SetRules.HasValidShape("distance", SetTypes.Work, 10m, 10, 10).Should().BeFalse();

    [Theory]
    [InlineData(1, true)]
    [InlineData(7.5, true)]
    [InlineData(10, true)]
    [InlineData(7.25, false)]
    [InlineData(8.1, false)]
    public void Rpe_OnlyInHalfSteps(double value, bool expected) =>
        SetRules.IsHalfStep((decimal)value).Should().Be(expected);

    [Theory]
    [InlineData("warmup", true)]
    [InlineData("work", true)]
    [InlineData("failure", true)]
    [InlineData("drop", true)]
    [InlineData("Work", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void SetType_IsAClosedVocabulary(string? value, bool expected) =>
        SetTypes.IsValid(value).Should().Be(expected);
}
