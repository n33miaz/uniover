using UniOver.Modules.Training.Domain.Body;

namespace UniOver.Modules.Training.Features.Body;

/// <summary>
/// A medição como o aparelho a recebe (leitura incremental e resposta da escrita). A lápide (<c>Deleted</c>) faz parte da
/// leitura: é por ela que outro aparelho fica sabendo que a medição foi apagada, e nela os valores vêm vazios.
/// <c>UpdatedAt</c> ordena o cursor.
/// </summary>
internal sealed record BodyEntryResponse(
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
    DateTimeOffset UpdatedAt,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted)
{
    public static BodyEntryResponse From(BodyEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);

        return new BodyEntryResponse(
            entry.Id,
            entry.MeasuredOn,
            entry.WeightKg,
            entry.BodyFatPct,
            entry.FatMethod,
            entry.WaistCm,
            entry.NeckCm,
            entry.HipCm,
            entry.ArmCm,
            entry.ThighCm,
            entry.ChestCm,
            entry.AbdomenCm,
            entry.ForearmCm,
            entry.CalfCm,
            entry.ArmRightCm,
            entry.ArmLeftCm,
            entry.ForearmRightCm,
            entry.ForearmLeftCm,
            entry.ThighRightCm,
            entry.ThighLeftCm,
            entry.CalfRightCm,
            entry.CalfLeftCm,
            entry.ChestSkinfoldMm,
            entry.AbdomenSkinfoldMm,
            entry.ThighSkinfoldMm,
            entry.Note,
            entry.UpdatedAt,
            entry.ClientUpdatedAt,
            entry.IsDeleted);
    }
}

/// <summary>O perfil como o aparelho o recebe. Não há id nem lápide: a chave é a própria pessoa.</summary>
internal sealed record BodyProfileResponse(
    decimal HeightCm,
    DateOnly BirthDate,
    string Sex,
    decimal ActivityFactor,
    DateTimeOffset UpdatedAt,
    DateTimeOffset ClientUpdatedAt)
{
    public static BodyProfileResponse From(BodyProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);

        return new BodyProfileResponse(
            profile.HeightCm,
            profile.BirthDate,
            profile.Sex,
            profile.ActivityFactor,
            profile.UpdatedAt,
            profile.ClientUpdatedAt);
    }
}
