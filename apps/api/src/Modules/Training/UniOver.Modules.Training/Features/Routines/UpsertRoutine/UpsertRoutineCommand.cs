using UniOver.Modules.Training.Domain.Routines;

namespace UniOver.Modules.Training.Features.Routines.UpsertRoutine;

/// <summary>Um item no corpo do <c>PUT /routines/{id}</c>.</summary>
internal sealed record UpsertRoutineItemRequest(
    Guid? Id,
    Guid? ExerciseId,
    int? Position,
    int? TargetSets,
    int? RepMin,
    int? RepMax,
    int? RestSeconds,
    int? SupersetGroup,
    string? Note);

/// <summary>Corpo do <c>PUT /routines/{id}</c>: a rotina inteira, escrita no aparelho (o id é do aparelho).</summary>
internal sealed record UpsertRoutineRequest(
    string? Name,
    int? Position,
    bool? Active,
    string? Note,
    IReadOnlyList<UpsertRoutineItemRequest>? Items,
    DateTimeOffset? ClientUpdatedAt,
    bool Deleted,
    string? ProgramId = null,
    IReadOnlyList<int>? Weekdays = null);

/// <summary>O pedido já validado e normalizado (nome aparado, itens arrumados e com as posições recompactadas).</summary>
internal sealed record UpsertRoutineCommand(
    Guid UserId,
    Guid Id,
    string Name,
    int Position,
    bool Active,
    string? Note,
    IReadOnlyList<RoutineItemSpec> Items,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted,
    string? ProgramId,
    int[]? Weekdays);

internal enum UpsertRoutineOutcome
{
    Ok,
    NotFound,
    ExerciseNotFound,
    SupersetNotContiguous,
    ClockAhead,
}

internal sealed record UpsertRoutineResult(UpsertRoutineOutcome Outcome, RoutineResponse? Routine = null);
