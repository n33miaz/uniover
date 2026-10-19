using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Sessions;

namespace UniOver.Modules.Training.Features.Sessions.UpsertSession;

/// <summary>Validação da borda da sessão: nada chega ao handler sem passar por aqui.</summary>
internal static class UpsertSessionValidator
{
    public static Dictionary<string, string[]> Validate(
        Guid id, UpsertSessionRequest? request, Guid userId, out UpsertSessionCommand? command)
    {
        command = null;
        var errors = new Dictionary<string, string[]>();

        if (request is null)
        {
            errors["body"] = ["Informe o treino no corpo da requisição."];
            return errors;
        }

        if (id == Guid.Empty)
        {
            errors["id"] = ["O id do treino é obrigatório."];
        }

        if (request.StartedAt is null || request.StartedAt == default(DateTimeOffset))
        {
            errors["startedAt"] = ["Informe quando o treino começou."];
        }

        if (request.RoutineId == Guid.Empty)
        {
            errors["routineId"] = ["A rotina informada não é válida."];
        }

        var note = request.Note?.Trim();
        if (note is { Length: > SessionLimits.NoteMax })
        {
            errors["note"] = [$"A anotação aceita até {SessionLimits.NoteMax} caracteres."];
        }

        if (request.Feeling is { } feeling && (feeling < SessionLimits.FeelingMin || feeling > SessionLimits.FeelingMax))
        {
            errors["feeling"] = [$"A sensação deve ficar entre {SessionLimits.FeelingMin} e {SessionLimits.FeelingMax}."];
        }

        var deviceId = request.DeviceId?.Trim() ?? string.Empty;
        if (deviceId.Length is 0 or > SessionLimits.DeviceIdMax)
        {
            errors["deviceId"] = [$"O aparelho deve ter de 1 a {SessionLimits.DeviceIdMax} caracteres."];
        }

        if (request.ClientUpdatedAt is null || request.ClientUpdatedAt == default(DateTimeOffset))
        {
            errors["clientUpdatedAt"] = ["Informe o instante da escrita no aparelho."];
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        command = new UpsertSessionCommand(
            userId,
            id,
            request.RoutineId,
            TimeStamps.ToStorage(request.StartedAt!.Value),
            request.FinishedAt is { } finished ? TimeStamps.ToStorage(finished) : null,
            string.IsNullOrEmpty(note) ? null : note,
            request.Feeling,
            deviceId,
            TimeStamps.ToStorage(request.ClientUpdatedAt!.Value),
            request.Deleted);
        return errors;
    }
}
