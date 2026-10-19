using AwesomeAssertions;
using UniOver.Modules.Training.Domain.Goals;
using UniOver.Modules.Training.Features.Goals.PullGoals;
using UniOver.Modules.Training.Features.Goals.UpsertGoal;

namespace UniOver.Modules.Training.Tests.Goals;

public class GoalRulesTests
{
    private static readonly Guid UserId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid ExerciseId = Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ab");
    private static readonly DateTimeOffset Stamp = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private static Dictionary<string, string[]> Run(string? kind, UpsertGoalRequest? request, out UpsertGoalCommand? command) =>
        UpsertGoalValidator.Validate(kind, request, UserId, out command);

    [Fact]
    public void Kinds_AreTheThreeStableValues_AndOnlyTheE1rmGoalNeedsAnExercise()
    {
        GoalKinds.All.Should().Equal("exercise_e1rm", "weekly_sessions", "daily_kcal");
        GoalKinds.IsValid("exercise_e1rm").Should().BeTrue();
        GoalKinds.IsValid("weight").Should().BeFalse();
        GoalKinds.IsValid(null).Should().BeFalse();
        GoalKinds.RequiresExercise(GoalKinds.ExerciseE1rm).Should().BeTrue();
        GoalKinds.RequiresExercise(GoalKinds.WeeklySessions).Should().BeFalse();
        GoalKinds.RequiresExercise(GoalKinds.DailyKcal).Should().BeFalse();
    }

    [Theory]
    [InlineData("weekly_sessions", 1, true)]
    [InlineData("weekly_sessions", 14, true)]
    [InlineData("weekly_sessions", 0, false)]
    [InlineData("weekly_sessions", 15, false)]
    [InlineData("exercise_e1rm", 1, true)]
    [InlineData("exercise_e1rm", 1000, true)]
    [InlineData("exercise_e1rm", 0.99, false)]
    [InlineData("exercise_e1rm", 1000.01, false)]
    [InlineData("daily_kcal", 500, true)]
    [InlineData("daily_kcal", 10000, true)]
    [InlineData("daily_kcal", 499.99, false)]
    [InlineData("daily_kcal", 10001, false)]
    [InlineData("daily_kcal", -2000, false)]
    public void ValueLimits_FollowTheKind(string kind, double value, bool valid) =>
        GoalLimits.IsValid(kind, (decimal)value).Should().Be(valid);

    [Fact]
    public void Value_WithMoreThanTwoDecimals_IsRefused()
    {
        GoalLimits.IsValid(GoalKinds.ExerciseE1rm, 55.55m).Should().BeTrue();
        GoalLimits.IsValid(GoalKinds.ExerciseE1rm, 55.555m).Should().BeFalse();
        GoalLimits.IsValid("unknown", 5m).Should().BeFalse();
    }

    [Fact]
    public void ValidE1rmGoal_BecomesACommand_WithTheNaturalKey()
    {
        var errors = Run("exercise_e1rm", new UpsertGoalRequest(ExerciseId, 55m, Stamp), out var command);

        errors.Should().BeEmpty();
        command.Should().Be(new UpsertGoalCommand(UserId, "exercise_e1rm", ExerciseId, 55m, Stamp));
    }

    [Fact]
    public void WeeklyGoal_WithoutExercise_IsValid_AndWithAnExerciseIsRefused()
    {
        Run("weekly_sessions", new UpsertGoalRequest(null, 3m, Stamp), out var command).Should().BeEmpty();
        command!.ExerciseId.Should().BeNull();

        Run("weekly_sessions", new UpsertGoalRequest(ExerciseId, 3m, Stamp), out _).Should().ContainKey("exerciseId");
        Run("daily_kcal", new UpsertGoalRequest(ExerciseId, 2200m, Stamp), out _).Should().ContainKey("exerciseId");
    }

    [Fact]
    public void E1rmGoal_WithoutExercise_IsRefused()
    {
        Run("exercise_e1rm", new UpsertGoalRequest(null, 55m, Stamp), out _).Should().ContainKey("exerciseId");
        Run("exercise_e1rm", new UpsertGoalRequest(Guid.Empty, 55m, Stamp), out _).Should().ContainKey("exerciseId");
    }

    [Fact]
    public void NullValue_IsTheTombstone_AndStillNeedsTheKey()
    {
        Run("exercise_e1rm", new UpsertGoalRequest(ExerciseId, null, Stamp), out var command).Should().BeEmpty();
        command!.Value.Should().BeNull();

        Run("exercise_e1rm", new UpsertGoalRequest(null, null, Stamp), out _).Should().ContainKey("exerciseId");
    }

    [Fact]
    public void UnknownKind_MissingBody_AndMissingClock_AreRefused()
    {
        Run("weight", new UpsertGoalRequest(null, 3m, Stamp), out var command).Should().ContainKey("kind");
        command.Should().BeNull();

        Run("weekly_sessions", null, out command).Should().ContainKey("body");
        command.Should().BeNull();

        Run("weekly_sessions", new UpsertGoalRequest(null, 3m, null), out _).Should().ContainKey("clientUpdatedAt");
        Run("weekly_sessions", new UpsertGoalRequest(null, 3m, default(DateTimeOffset)), out _).Should().ContainKey("clientUpdatedAt");
    }

    [Fact]
    public void OutOfRangeValue_NamesTheValueField()
    {
        Run("weekly_sessions", new UpsertGoalRequest(null, 15m, Stamp), out var command).Should().ContainKey("value");
        command.Should().BeNull();
        Run("weekly_sessions", new UpsertGoalRequest(null, 0m, Stamp), out _).Should().ContainKey("value");
    }

    [Fact]
    public void ClientInstant_IsTruncatedToTheStorageResolution()
    {
        var precise = Stamp.AddTicks(7);

        Run("weekly_sessions", new UpsertGoalRequest(null, 3m, precise), out var command).Should().BeEmpty();

        command!.ClientUpdatedAt.Should().Be(Stamp);
    }

    [Fact]
    public void Pull_ValidatesTheCursorAndTheLimit()
    {
        PullGoalsValidator.Validate(null, null, out var cursor, out var size).Should().BeEmpty();
        cursor.Should().BeNull();
        size.Should().Be(200);

        PullGoalsValidator.Validate("não é cursor", 10, out _, out _).Should().ContainKey("after");
        PullGoalsValidator.Validate(null, 0, out _, out _).Should().ContainKey("limit");
        PullGoalsValidator.Validate(null, 501, out _, out _).Should().ContainKey("limit");
        PullGoalsValidator.Validate(null, 500, out _, out size).Should().BeEmpty();
        size.Should().Be(500);
    }
}
