using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Goals;

namespace UniOver.Modules.Training.Features.Goals.UpsertGoal;

/// <summary>Validação da borda da meta: nada chega ao handler sem passar por aqui.</summary>
internal static class UpsertGoalValidator
{
    public static Dictionary<string, string[]> Validate(
        string? kind, UpsertGoalRequest? request, Guid userId, out UpsertGoalCommand? command)
    {
        command = null;
        var errors = new Dictionary<string, string[]>();

        var kindIsValid = GoalKinds.IsValid(kind);
        if (!kindIsValid)
        {
            errors["kind"] = [$"O tipo da meta deve ser um destes: {string.Join(", ", GoalKinds.All)}."];
        }

        if (request is null)
        {
            errors["body"] = ["Informe a meta no corpo da requisição."];
            return errors;
        }

        if (kindIsValid)
        {
            if (GoalKinds.RequiresExercise(kind!))
            {
                if (request.ExerciseId is null || request.ExerciseId == Guid.Empty)
                {
                    errors["exerciseId"] = ["A meta de 1RM precisa do exercício."];
                }
            }
            else if (request.ExerciseId is not null)
            {
                errors["exerciseId"] = ["Só a meta de 1RM tem exercício."];
            }

            if (request.Value is { } value && !GoalLimits.IsValid(kind!, value))
            {
                var (min, max) = GoalLimits.RangeOf(kind!)!.Value;
                errors["value"] = [$"O valor deve ficar entre {min} e {max}, com no máximo {GoalLimits.ValueScale} casas decimais."];
            }
        }

        if (request.ClientUpdatedAt is null || request.ClientUpdatedAt == default(DateTimeOffset))
        {
            errors["clientUpdatedAt"] = ["Informe o instante da escrita no aparelho."];
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        command = new UpsertGoalCommand(
            userId,
            kind!,
            request.ExerciseId,
            request.Value,
            TimeStamps.ToStorage(request.ClientUpdatedAt!.Value));
        return errors;
    }
}
