using UniOver.Modules.Training.Domain.Routines;

namespace UniOver.Modules.Training.Features.Routines;

/// <summary>Um item da rotina como o aparelho o recebe.</summary>
internal sealed record RoutineItemResponse(
    Guid Id,
    Guid ExerciseId,
    int Position,
    int TargetSets,
    int RepMin,
    int RepMax,
    int RestSeconds,
    int? SupersetGroup,
    string? Note);

/// <summary>
/// A rotina como o aparelho a recebe (leitura incremental e resposta da escrita): sempre completa, com os itens em ordem.
/// A lápide (<c>Deleted</c>) faz parte da leitura: é por ela que outro aparelho fica sabendo que a rotina foi apagada.
/// <c>UpdatedAt</c> é o instante de ordenação do cursor.
/// </summary>
internal sealed record RoutineResponse(
    Guid Id,
    string Name,
    int Position,
    bool Active,
    string? Note,
    IReadOnlyList<RoutineItemResponse> Items,
    DateTimeOffset UpdatedAt,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted)
{
    public static RoutineResponse From(Routine routine)
    {
        ArgumentNullException.ThrowIfNull(routine);

        return new RoutineResponse(
            routine.Id,
            routine.Name,
            routine.Position,
            routine.Active,
            routine.Note,
            [.. routine.Items
                .OrderBy(i => i.Position)
                .Select(i => new RoutineItemResponse(
                    i.Id, i.ExerciseId, i.Position, i.TargetSets, i.RepMin, i.RepMax, i.RestSeconds, i.SupersetGroup, i.Note))],
            routine.UpdatedAt,
            routine.ClientUpdatedAt,
            routine.IsDeleted);
    }
}
