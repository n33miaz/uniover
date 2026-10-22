namespace UniOver.Modules.Training.Features.Body.UpsertBodyEntry;

/// <summary>Corpo do <c>PUT /body/entries/{id}</c>: a medição inteira, escrita no aparelho (o id é do aparelho).</summary>
internal sealed record UpsertBodyEntryRequest(
    DateOnly? MeasuredOn,
    decimal? WeightKg,
    decimal? BodyFatPct,
    string? FatMethod,
    decimal? WaistCm,
    decimal? NeckCm,
    decimal? HipCm,
    decimal? ArmCm,
    decimal? ThighCm,
    string? Note,
    DateTimeOffset? ClientUpdatedAt,
    bool Deleted);

/// <summary>O pedido já validado e normalizado (texto aparado, instantes no relógio de armazenamento).</summary>
internal sealed record UpsertBodyEntryCommand(
    Guid UserId,
    Guid Id,
    DateOnly MeasuredOn,
    decimal? WeightKg,
    decimal? BodyFatPct,
    string? FatMethod,
    decimal? WaistCm,
    decimal? NeckCm,
    decimal? HipCm,
    decimal? ArmCm,
    decimal? ThighCm,
    string? Note,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted)
{
    /// <summary>Tem ao menos um valor medido (a anotação sozinha não conta).</summary>
    public bool HasAnyValue =>
        WeightKg is not null || BodyFatPct is not null || WaistCm is not null || NeckCm is not null
        || HipCm is not null || ArmCm is not null || ThighCm is not null;
}

internal enum UpsertBodyEntryOutcome
{
    Ok,
    NotFound,
    Empty,
    ClockAhead,
}

internal sealed record UpsertBodyEntryResult(UpsertBodyEntryOutcome Outcome, BodyEntryResponse? Entry = null);
