using AwesomeAssertions;
using UniOver.Modules.Training.Domain.Sessions;
using UniOver.Modules.Training.Features.Sessions.PullSessions;
using UniOver.Modules.Training.Features.Sessions.UpsertSession;
using UniOver.Modules.Training.Features.Sessions.UpsertSet;

namespace UniOver.Modules.Training.Tests.Sessions;

public class SessionValidatorTests
{
    private static readonly Guid UserId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid SessionId = Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ab");
    private static readonly Guid SetId = Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ac");
    private static readonly DateTimeOffset Stamp = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private static UpsertSessionRequest ValidSession() => new(
        RoutineId: null, StartedAt: Stamp, FinishedAt: null, Note: null, Feeling: null,
        DeviceId: "aparelho-1", ClientUpdatedAt: Stamp, Deleted: false);

    private static Dictionary<string, string[]> RunSession(UpsertSessionRequest? request, out UpsertSessionCommand? command, Guid? id = null) =>
        UpsertSessionValidator.Validate(id ?? SessionId, request, UserId, out command);

    private static UpsertSetRequest ValidSet() => new(
        ExerciseId: Guid.NewGuid(), Position: 0, SetType: "work", WeightKg: 82.5m, Reps: 8, DurationS: null,
        Rir: 2, Rpe: 8m, Note: null, CompletedAt: Stamp, ClientUpdatedAt: Stamp, Deleted: false);

    private static Dictionary<string, string[]> RunSet(UpsertSetRequest? request, out UpsertSetCommand? command) =>
        UpsertSetValidator.Validate(SessionId, SetId, request, UserId, out command);

    [Fact]
    public void ValidSession_BecomesANormalizedCommand()
    {
        var errors = RunSession(ValidSession() with { Note = "  boa sessão  ", DeviceId = "  aparelho-1 ", Feeling = 4 }, out var command);

        errors.Should().BeEmpty();
        command!.Note.Should().Be("boa sessão");
        command.DeviceId.Should().Be("aparelho-1");
        command.Feeling.Should().Be(4);
        command.UserId.Should().Be(UserId);
        command.Id.Should().Be(SessionId);
    }

    [Fact]
    public void BlankSessionNote_BecomesNull()
    {
        RunSession(ValidSession() with { Note = "   " }, out var command).Should().BeEmpty();

        command!.Note.Should().BeNull();
    }

    [Fact]
    public void MissingSessionBody_IsRefused()
    {
        RunSession(null, out var command).Should().ContainKey("body");
        command.Should().BeNull();
    }

    [Fact]
    public void SessionWithoutStart_Device_OrClock_IsRefused()
    {
        RunSession(ValidSession() with { StartedAt = null }, out _).Should().ContainKey("startedAt");
        RunSession(ValidSession() with { DeviceId = null }, out _).Should().ContainKey("deviceId");
        RunSession(ValidSession() with { DeviceId = "   " }, out _).Should().ContainKey("deviceId");
        RunSession(ValidSession() with { ClientUpdatedAt = null }, out _).Should().ContainKey("clientUpdatedAt");
        RunSession(ValidSession(), out _, Guid.Empty).Should().ContainKey("id");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(6)]
    [InlineData(-1)]
    public void SessionFeeling_OutOfRange_IsRefused(int feeling) =>
        RunSession(ValidSession() with { Feeling = feeling }, out _).Should().ContainKey("feeling");

    [Fact]
    public void SessionLimits_AreEnforced()
    {
        RunSession(ValidSession() with { DeviceId = new string('a', SessionLimits.DeviceIdMax + 1) }, out _).Should().ContainKey("deviceId");
        RunSession(ValidSession() with { DeviceId = new string('a', SessionLimits.DeviceIdMax) }, out _).Should().BeEmpty();
        RunSession(ValidSession() with { Note = new string('a', SessionLimits.NoteMax + 1) }, out _).Should().ContainKey("note");
        RunSession(ValidSession() with { Note = new string('a', SessionLimits.NoteMax) }, out _).Should().BeEmpty();
        RunSession(ValidSession() with { RoutineId = Guid.Empty }, out _).Should().ContainKey("routineId");
    }

    [Fact]
    public void ValidSet_BecomesACommand_WithTheSessionAndTheOwner()
    {
        var errors = RunSet(ValidSet() with { Note = "  devagar " }, out var command);

        errors.Should().BeEmpty();
        command!.SessionId.Should().Be(SessionId);
        command.Id.Should().Be(SetId);
        command.UserId.Should().Be(UserId);
        command.Note.Should().Be("devagar");
        command.WeightKg.Should().Be(82.5m);
    }

    [Fact]
    public void SetWithoutRequiredFields_IsRefused()
    {
        RunSet(ValidSet() with { ExerciseId = null }, out _).Should().ContainKey("exerciseId");
        RunSet(ValidSet() with { Position = null }, out _).Should().ContainKey("position");
        RunSet(ValidSet() with { SetType = null }, out _).Should().ContainKey("setType");
        RunSet(ValidSet() with { CompletedAt = null }, out _).Should().ContainKey("completedAt");
        RunSet(ValidSet() with { ClientUpdatedAt = null }, out _).Should().ContainKey("clientUpdatedAt");
        RunSet(null, out _).Should().ContainKey("body");
    }

    [Theory]
    [InlineData("setType", "pyramid")]
    [InlineData("weightKg", -1)]
    [InlineData("weightKg", 100000)]
    [InlineData("weightKg", 82.555)]
    [InlineData("reps", 1000)]
    [InlineData("reps", -1)]
    [InlineData("durationS", 86401)]
    [InlineData("rir", 11)]
    [InlineData("rir", -1)]
    [InlineData("rpe", 0.5)]
    [InlineData("rpe", 10.5)]
    [InlineData("rpe", 7.25)]
    public void SetOutOfLimits_IsRefused(string field, object value)
    {
        var request = field switch
        {
            "setType" => ValidSet() with { SetType = (string)value },
            "weightKg" => ValidSet() with { WeightKg = Convert.ToDecimal(value, System.Globalization.CultureInfo.InvariantCulture) },
            "reps" => ValidSet() with { Reps = (int)value },
            "durationS" => ValidSet() with { DurationS = (int)value },
            "rir" => ValidSet() with { Rir = (int)value },
            _ => ValidSet() with { Rpe = Convert.ToDecimal(value, System.Globalization.CultureInfo.InvariantCulture) },
        };

        RunSet(request, out var command).Should().ContainKey(field);
        command.Should().BeNull();
    }

    [Fact]
    public void SetEdges_AreAccepted()
    {
        RunSet(ValidSet() with { Reps = 0, Rir = 0, Rpe = 1m, WeightKg = 0m }, out _).Should().BeEmpty();
        RunSet(ValidSet() with { Reps = 999, Rir = 10, Rpe = 10m, WeightKg = 99999.99m, DurationS = 86400 }, out _).Should().BeEmpty();
        RunSet(ValidSet() with { Note = new string('a', SessionLimits.SetNoteMax) }, out _).Should().BeEmpty();
        RunSet(ValidSet() with { Note = new string('a', SessionLimits.SetNoteMax + 1) }, out _).Should().ContainKey("note");
    }

    [Fact]
    public void PullPage_ValidatesCursorAndLimit()
    {
        PullPageValidator.Validate(null, null, out var cursor, out var size).Should().BeEmpty();
        cursor.Should().BeNull();
        size.Should().Be(200);

        PullPageValidator.Validate("lixo", null, out _, out _).Should().ContainKey("after");
        PullPageValidator.Validate(null, 0, out _, out _).Should().ContainKey("limit");
        PullPageValidator.Validate(null, 501, out _, out _).Should().ContainKey("limit");
        PullPageValidator.Validate(null, 500, out _, out _).Should().BeEmpty();
    }
}
