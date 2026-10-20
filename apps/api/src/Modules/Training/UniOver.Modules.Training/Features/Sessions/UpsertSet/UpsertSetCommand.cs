namespace UniOver.Modules.Training.Features.Sessions.UpsertSet;

/// <summary>Corpo do <c>PUT /sessions/{sessionId}/sets/{id}</c>: a série inteira, escrita no aparelho (o id é do aparelho).</summary>
internal sealed record UpsertSetRequest(
    Guid? ExerciseId,
    int? Position,
    string? SetType,
    decimal? WeightKg,
    int? Reps,
    int? DurationS,
    int? Rir,
    decimal? Rpe,
    string? Note,
    DateTimeOffset? CompletedAt,
    DateTimeOffset? ClientUpdatedAt,
    bool Deleted);

/// <summary>O pedido já validado campo a campo (a forma conforme o tipo de registro do exercício o handler confere).</summary>
internal sealed record UpsertSetCommand(
    Guid UserId,
    Guid SessionId,
    Guid Id,
    Guid ExerciseId,
    int Position,
    string SetType,
    decimal? WeightKg,
    int? Reps,
    int? DurationS,
    int? Rir,
    decimal? Rpe,
    string? Note,
    DateTimeOffset CompletedAt,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted);

internal enum UpsertSetOutcome
{
    Ok,
    SessionNotFound,
    ExerciseNotFound,
    ShapeInvalid,
    ClockAhead,
}

internal sealed record UpsertSetResult(UpsertSetOutcome Outcome, SetResponse? Set = null);
