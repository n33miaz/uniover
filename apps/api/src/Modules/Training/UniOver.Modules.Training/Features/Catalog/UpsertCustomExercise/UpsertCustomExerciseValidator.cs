using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Features.Catalog.UpsertCustomExercise;

/// <summary>Validação da borda do exercício próprio: nada chega ao handler sem passar por aqui.</summary>
internal static class UpsertCustomExerciseValidator
{
    public const decimal StepMax = 1000m;
    public const int SecondaryMusclesMax = 6;

    public static Dictionary<string, string[]> Validate(
        Guid id, UpsertCustomExerciseRequest? request, Guid userId, out UpsertCustomExerciseCommand? command)
    {
        command = null;
        var errors = new Dictionary<string, string[]>();

        if (request is null)
        {
            errors["body"] = ["Informe o exercício no corpo da requisição."];
            return errors;
        }

        if (id == Guid.Empty)
        {
            errors["id"] = ["O id do exercício é obrigatório."];
        }

        var name = request.Name?.Trim() ?? string.Empty;
        if (name.Length is 0 or > Exercise.NameMax)
        {
            errors["name"] = [$"O nome deve ter de 1 a {Exercise.NameMax} caracteres."];
        }

        var primary = request.PrimaryMuscles ?? [];
        if (primary.Count is < 1 or > Exercise.MusclesMax)
        {
            errors["primaryMuscles"] = [$"Informe de 1 a {Exercise.MusclesMax} músculos principais."];
        }
        else if (primary.Any(m => !Muscle.IsValid(m)) || primary.Distinct(StringComparer.Ordinal).Count() != primary.Count)
        {
            errors["primaryMuscles"] = ["Os músculos principais devem ser distintos e da lista do catálogo."];
        }

        var secondary = request.SecondaryMuscles ?? [];
        if (secondary.Count > SecondaryMusclesMax
            || secondary.Any(m => !Muscle.IsValid(m))
            || secondary.Distinct(StringComparer.Ordinal).Count() != secondary.Count)
        {
            errors["secondaryMuscles"] = [$"Os músculos secundários devem ser distintos, da lista do catálogo e no máximo {SecondaryMusclesMax}."];
        }

        if (!Equipment.IsValid(request.Equipment))
        {
            errors["equipment"] = ["O equipamento não é válido."];
        }

        if (!ExerciseRecordTypes.IsValid(request.RecordType))
        {
            errors["recordType"] = ["O tipo de registro não é válido."];
        }

        if (request.StepKg is { } step && (step < 0 || step > StepMax || decimal.Round(step, 2) != step))
        {
            errors["stepKg"] = [$"O salto de carga deve ficar entre 0 e {StepMax} kg, com no máximo 2 casas."];
        }

        var instructions = request.Instructions ?? [];
        if (instructions.Count > Exercise.InstructionsMax
            || instructions.Any(i => string.IsNullOrWhiteSpace(i) || i.Length > Exercise.InstructionMax))
        {
            errors["instructions"] = [$"Informe no máximo {Exercise.InstructionsMax} instruções, cada uma de 1 a {Exercise.InstructionMax} caracteres."];
        }

        if (request.ClientUpdatedAt is null || request.ClientUpdatedAt == default(DateTimeOffset))
        {
            errors["clientUpdatedAt"] = ["Informe o instante da escrita no aparelho."];
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        command = new UpsertCustomExerciseCommand(
            userId,
            id,
            name,
            [.. primary],
            [.. secondary],
            request.Equipment!,
            request.RecordType!,
            request.StepKg,
            [.. instructions.Select(i => i.Trim())],
            TimeStamps.ToStorage(request.ClientUpdatedAt!.Value),
            request.Deleted);
        return errors;
    }
}
