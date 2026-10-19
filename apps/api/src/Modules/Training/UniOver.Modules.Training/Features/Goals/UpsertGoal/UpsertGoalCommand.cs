namespace UniOver.Modules.Training.Features.Goals.UpsertGoal;

/// <summary>
/// Corpo do <c>PUT /goals/{kind}</c>. O id de negócio é a chave natural (tipo + exercício): <c>Value</c> nulo é a lápide.
/// </summary>
internal sealed record UpsertGoalRequest(Guid? ExerciseId, decimal? Value, DateTimeOffset? ClientUpdatedAt);

/// <summary>O pedido já validado e normalizado (instantes no relógio de armazenamento).</summary>
internal sealed record UpsertGoalCommand(
    Guid UserId,
    string Kind,
    Guid? ExerciseId,
    decimal? Value,
    DateTimeOffset ClientUpdatedAt);

internal enum UpsertGoalOutcome
{
    Ok,
    ExerciseNotFound,
    ClockAhead,
}

internal sealed record UpsertGoalResult(UpsertGoalOutcome Outcome, GoalResponse? Goal = null);
