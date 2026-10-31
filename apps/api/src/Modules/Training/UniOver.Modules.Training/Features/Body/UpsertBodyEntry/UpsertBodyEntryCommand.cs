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
    bool Deleted,
    decimal? ChestCm = null,
    decimal? AbdomenCm = null,
    decimal? ForearmCm = null,
    decimal? CalfCm = null,
    decimal? ArmRightCm = null,
    decimal? ArmLeftCm = null,
    decimal? ForearmRightCm = null,
    decimal? ForearmLeftCm = null,
    decimal? ThighRightCm = null,
    decimal? ThighLeftCm = null,
    decimal? CalfRightCm = null,
    decimal? CalfLeftCm = null,
    decimal? ChestSkinfoldMm = null,
    decimal? AbdomenSkinfoldMm = null,
    decimal? ThighSkinfoldMm = null);

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
    decimal? ChestCm,
    decimal? AbdomenCm,
    decimal? ForearmCm,
    decimal? CalfCm,
    decimal? ArmRightCm,
    decimal? ArmLeftCm,
    decimal? ForearmRightCm,
    decimal? ForearmLeftCm,
    decimal? ThighRightCm,
    decimal? ThighLeftCm,
    decimal? CalfRightCm,
    decimal? CalfLeftCm,
    decimal? ChestSkinfoldMm,
    decimal? AbdomenSkinfoldMm,
    decimal? ThighSkinfoldMm,
    string? Note,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted)
{
    /// <summary>Tem ao menos um valor medido (a anotação sozinha não conta).</summary>
    public bool HasAnyValue =>
        WeightKg is not null || BodyFatPct is not null || WaistCm is not null || NeckCm is not null
        || HipCm is not null || ArmCm is not null || ThighCm is not null || ChestCm is not null || AbdomenCm is not null
        || ForearmCm is not null || CalfCm is not null || ArmRightCm is not null || ArmLeftCm is not null
        || ForearmRightCm is not null || ForearmLeftCm is not null || ThighRightCm is not null || ThighLeftCm is not null
        || CalfRightCm is not null || CalfLeftCm is not null || ChestSkinfoldMm is not null || AbdomenSkinfoldMm is not null
        || ThighSkinfoldMm is not null;
}

internal enum UpsertBodyEntryOutcome
{
    Ok,
    NotFound,
    Empty,
    ClockAhead,
}

internal sealed record UpsertBodyEntryResult(UpsertBodyEntryOutcome Outcome, BodyEntryResponse? Entry = null);
