using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Sessions;

namespace UniOver.Modules.Training.Features.Sessions.UpsertSet;

/// <summary>Validação da borda da série: limites de cada campo. A forma por tipo de registro é do handler.</summary>
internal static class UpsertSetValidator
{
    public static Dictionary<string, string[]> Validate(
        Guid sessionId, Guid id, UpsertSetRequest? request, Guid userId, out UpsertSetCommand? command)
    {
        command = null;
        var errors = new Dictionary<string, string[]>();

        if (request is null)
        {
            errors["body"] = ["Informe a série no corpo da requisição."];
            return errors;
        }

        if (id == Guid.Empty)
        {
            errors["id"] = ["O id da série é obrigatório."];
        }

        if (sessionId == Guid.Empty)
        {
            errors["sessionId"] = ["O id do treino é obrigatório."];
        }

        if (request.ExerciseId is null || request.ExerciseId == Guid.Empty)
        {
            errors["exerciseId"] = ["O exercício da série é obrigatório."];
        }

        if (request.Position is null or < 0 or > SessionLimits.PositionMax)
        {
            errors["position"] = [$"A posição deve ficar entre 0 e {SessionLimits.PositionMax}."];
        }

        if (!SetTypes.IsValid(request.SetType))
        {
            errors["setType"] = [$"O tipo da série deve ser um destes: {string.Join(", ", SetTypes.All)}."];
        }

        if (request.WeightKg is { } weight && (weight < 0 || weight > SessionLimits.WeightMaxKg || decimal.Round(weight, 2) != weight))
        {
            errors["weightKg"] = [$"A carga deve ficar entre 0 e {SessionLimits.WeightMaxKg} kg, com até duas casas decimais."];
        }

        if (request.Reps is { } reps && (reps < 0 || reps > SessionLimits.RepsMax))
        {
            errors["reps"] = [$"As repetições devem ficar entre 0 e {SessionLimits.RepsMax}."];
        }

        if (request.DurationS is { } duration && (duration < 0 || duration > SessionLimits.DurationMaxSeconds))
        {
            errors["durationS"] = [$"A duração deve ficar entre 0 e {SessionLimits.DurationMaxSeconds} segundos."];
        }

        if (request.Rir is { } rir && (rir < 0 || rir > SessionLimits.RirMax))
        {
            errors["rir"] = [$"As repetições em reserva devem ficar entre 0 e {SessionLimits.RirMax}."];
        }

        if (request.Rpe is { } rpe && (rpe < SessionLimits.RpeMin || rpe > SessionLimits.RpeMax || !SetRules.IsHalfStep(rpe)))
        {
            errors["rpe"] = ["O esforço deve ficar entre 1 e 10, em passos de 0,5."];
        }

        var note = request.Note?.Trim();
        if (note is { Length: > SessionLimits.SetNoteMax })
        {
            errors["note"] = [$"A anotação aceita até {SessionLimits.SetNoteMax} caracteres."];
        }

        if (request.CompletedAt is null || request.CompletedAt == default(DateTimeOffset))
        {
            errors["completedAt"] = ["Informe quando a série foi concluída."];
        }

        if (request.ClientUpdatedAt is null || request.ClientUpdatedAt == default(DateTimeOffset))
        {
            errors["clientUpdatedAt"] = ["Informe o instante da escrita no aparelho."];
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        command = new UpsertSetCommand(
            userId,
            sessionId,
            id,
            request.ExerciseId!.Value,
            request.Position!.Value,
            request.SetType!,
            request.WeightKg,
            request.Reps,
            request.DurationS,
            request.Rir,
            request.Rpe,
            string.IsNullOrEmpty(note) ? null : note,
            TimeStamps.ToStorage(request.CompletedAt!.Value),
            TimeStamps.ToStorage(request.ClientUpdatedAt!.Value),
            request.Deleted);
        return errors;
    }
}
