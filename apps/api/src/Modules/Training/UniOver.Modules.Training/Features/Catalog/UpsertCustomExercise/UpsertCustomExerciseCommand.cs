namespace UniOver.Modules.Training.Features.Catalog.UpsertCustomExercise;

/// <summary>Corpo do <c>PUT /exercises/{id}</c>: o exercício próprio inteiro, escrito no aparelho (o id é do aparelho).</summary>
internal sealed record UpsertCustomExerciseRequest(
    string? Name,
    IReadOnlyList<string>? PrimaryMuscles,
    IReadOnlyList<string>? SecondaryMuscles,
    string? Equipment,
    string? RecordType,
    decimal? StepKg,
    IReadOnlyList<string>? Instructions,
    DateTimeOffset? ClientUpdatedAt,
    bool Deleted);

/// <summary>O pedido já validado e normalizado (nome aparado, listas sem nulos).</summary>
internal sealed record UpsertCustomExerciseCommand(
    Guid UserId,
    Guid Id,
    string Name,
    IReadOnlyList<string> PrimaryMuscles,
    IReadOnlyList<string> SecondaryMuscles,
    string Equipment,
    string RecordType,
    decimal? StepKg,
    IReadOnlyList<string> Instructions,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted);

internal enum UpsertOutcome
{
    Ok,
    CatalogReadonly,
    NotFound,
    ClockAhead,
    /// <summary>Id novo que não é UUID v7: o exercício próprio nasce no aparelho, e o id do catálogo (v5) é de quem semeia.</summary>
    InvalidId,
}

internal sealed record UpsertCustomExerciseResult(UpsertOutcome Outcome, ExerciseResponse? Exercise = null);
