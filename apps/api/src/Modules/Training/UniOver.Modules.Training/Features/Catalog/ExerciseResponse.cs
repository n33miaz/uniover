using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Features.Catalog;

/// <summary>
/// O exercício como o aparelho o recebe (leitura incremental e resposta das escritas). <c>StepKg</c> já vem mesclado com
/// a escolha do dono; nulo vale o salto do equipamento. As lápides (<c>Deleted</c>) fazem parte da leitura: é por elas
/// que outro aparelho fica sabendo que o registro foi apagado. <c>UpdatedAt</c> é o instante de ordenação do cursor.
/// </summary>
internal sealed record ExerciseResponse(
    Guid Id,
    string Slug,
    string Source,
    string? SourceRef,
    string Name,
    IReadOnlyList<string> Instructions,
    IReadOnlyList<string> PrimaryMuscles,
    IReadOnlyList<string> SecondaryMuscles,
    string Equipment,
    string RecordType,
    decimal? StepKg,
    DateTimeOffset? StepClientUpdatedAt,
    string? Level,
    string? Category,
    string? Mechanic,
    string? License,
    string? LicenseAuthor,
    string? LicenseUrl,
    bool Reviewed,
    DateTimeOffset UpdatedAt,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted)
{
    public static ExerciseResponse From(Exercise exercise, ExerciseOverride? choice)
    {
        ArgumentNullException.ThrowIfNull(exercise);

        // Com linha de escolha, vale ela (nulo = volta ao salto do equipamento); sem linha, vale o do próprio exercício.
        var step = choice is not null ? choice.StepKg : exercise.StepKg;

        // O instante que ordena o cursor é o mais novo entre a linha e a escolha de salto: mudar o salto de um exercício de
        // catálogo também faz o registro voltar na leitura incremental, e o aparelho precisa ver esse instante mudar.
        var stamp = choice is not null && choice.UpdatedAt > exercise.UpdatedAt ? choice.UpdatedAt : exercise.UpdatedAt;
        return new ExerciseResponse(
            exercise.Id,
            exercise.Slug,
            exercise.Source,
            exercise.SourceRef,
            exercise.Name,
            exercise.Instructions,
            exercise.PrimaryMuscles,
            exercise.SecondaryMuscles,
            exercise.Equipment,
            exercise.RecordType,
            step,
            choice?.ClientUpdatedAt,
            exercise.Level,
            exercise.Category,
            exercise.Mechanic,
            exercise.License,
            exercise.LicenseAuthor,
            exercise.LicenseUrl,
            exercise.Reviewed,
            stamp,
            exercise.ClientUpdatedAt,
            exercise.DeletedAt is not null);
    }
}
