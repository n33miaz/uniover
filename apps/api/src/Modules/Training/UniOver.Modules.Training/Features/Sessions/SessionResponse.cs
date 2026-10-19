using UniOver.Modules.Training.Domain.Sessions;

namespace UniOver.Modules.Training.Features.Sessions;

/// <summary>
/// A sessão como o aparelho a recebe (leitura incremental e resposta da escrita). A lápide (<c>Deleted</c>) faz parte da
/// leitura: é por ela que outro aparelho fica sabendo que o treino foi apagado. <c>UpdatedAt</c> ordena o cursor.
/// </summary>
internal sealed record SessionResponse(
    Guid Id,
    Guid? RoutineId,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    string? Note,
    int? Feeling,
    string DeviceId,
    DateTimeOffset UpdatedAt,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted)
{
    public static SessionResponse From(Session session)
    {
        ArgumentNullException.ThrowIfNull(session);

        return new SessionResponse(
            session.Id,
            session.RoutineId,
            session.StartedAt,
            session.FinishedAt,
            session.Note,
            session.Feeling,
            session.DeviceId,
            session.UpdatedAt,
            session.ClientUpdatedAt,
            session.IsDeleted);
    }
}

/// <summary>A série como o aparelho a recebe; a série de uma sessão apagada chega como lápide.</summary>
internal sealed record SetResponse(
    Guid Id,
    Guid SessionId,
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
    DateTimeOffset UpdatedAt,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted)
{
    public static SetResponse From(SessionSet set)
    {
        ArgumentNullException.ThrowIfNull(set);

        return new SetResponse(
            set.Id,
            set.SessionId,
            set.ExerciseId,
            set.Position,
            set.SetType,
            set.WeightKg,
            set.Reps,
            set.DurationS,
            set.Rir,
            set.Rpe,
            set.Note,
            set.CompletedAt,
            set.UpdatedAt,
            set.ClientUpdatedAt,
            set.IsDeleted);
    }
}
