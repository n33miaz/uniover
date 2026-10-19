using UniOver.Modules.Training.Domain.Goals;

namespace UniOver.Modules.Training.Features.Goals;

/// <summary>
/// A meta como o aparelho a recebe (leitura incremental e resposta da escrita). A lápide (<c>Deleted</c>) faz parte da
/// leitura: é por ela que outro aparelho fica sabendo que a meta foi removida, e nela o valor vem vazio. <c>UpdatedAt</c>
/// ordena o cursor.
/// </summary>
internal sealed record GoalResponse(
    Guid Id,
    string Kind,
    Guid? ExerciseId,
    decimal? Value,
    DateTimeOffset UpdatedAt,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted)
{
    public static GoalResponse From(Goal goal)
    {
        ArgumentNullException.ThrowIfNull(goal);

        return new GoalResponse(
            goal.Id,
            goal.Kind,
            goal.ExerciseId,
            goal.IsDeleted ? null : goal.Value,
            goal.UpdatedAt,
            goal.ClientUpdatedAt,
            goal.IsDeleted);
    }
}
