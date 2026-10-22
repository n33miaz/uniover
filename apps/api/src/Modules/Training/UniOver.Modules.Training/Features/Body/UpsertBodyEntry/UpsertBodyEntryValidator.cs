using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Body;

namespace UniOver.Modules.Training.Features.Body.UpsertBodyEntry;

/// <summary>
/// Validação da borda da medição: nada chega ao handler sem passar por aqui. As mensagens dizem o limite, nunca o valor
/// recebido (dado de saúde não vai para texto de erro, que pode ir para log).
/// </summary>
internal static class UpsertBodyEntryValidator
{
    public static Dictionary<string, string[]> Validate(
        Guid id, UpsertBodyEntryRequest? request, Guid userId, DateOnly today, out UpsertBodyEntryCommand? command)
    {
        command = null;
        var errors = new Dictionary<string, string[]>();

        if (request is null)
        {
            errors["body"] = ["Informe a medição no corpo da requisição."];
            return errors;
        }

        if (id == Guid.Empty)
        {
            errors["id"] = ["O id da medição é obrigatório."];
        }

        var latest = today.AddDays((int)BodyLimits.MeasuredOnLeeway.TotalDays);
        if (request.MeasuredOn is not { } measuredOn)
        {
            errors["measuredOn"] = ["Informe a data da medição."];
        }
        else if (measuredOn < BodyLimits.EarliestDate || measuredOn > latest)
        {
            errors["measuredOn"] = ["A data da medição está fora do intervalo aceito."];
        }

        if (request.WeightKg is { } weight && !BodyLimits.IsValidWeight(weight))
        {
            errors["weightKg"] = [$"O peso deve ficar entre {BodyLimits.WeightMinKg} e {BodyLimits.WeightMaxKg} kg, com no máximo {BodyLimits.WeightScale} casas decimais."];
        }

        if (request.BodyFatPct is { } fat && !BodyLimits.IsValidBodyFat(fat))
        {
            errors["bodyFatPct"] = [$"A gordura deve ficar entre {BodyLimits.BodyFatMinPct} e {BodyLimits.BodyFatMaxPct} %, com no máximo {BodyLimits.OneDecimalScale} casa decimal."];
        }

        CheckCircumference(errors, "waistCm", request.WaistCm);
        CheckCircumference(errors, "neckCm", request.NeckCm);
        CheckCircumference(errors, "hipCm", request.HipCm);
        CheckCircumference(errors, "armCm", request.ArmCm);
        CheckCircumference(errors, "thighCm", request.ThighCm);

        // O método só existe junto do percentual (e vice-versa): gordura sem dizer de onde veio não se grava.
        if (request.BodyFatPct is not null)
        {
            if (!FatMethods.IsValid(request.FatMethod))
            {
                errors["fatMethod"] = [$"O método da gordura deve ser um destes: {string.Join(", ", FatMethods.All)}."];
            }
        }
        else if (request.FatMethod is not null)
        {
            errors["fatMethod"] = ["O método só vale junto do percentual de gordura."];
        }

        var note = request.Note?.Trim();
        if (note is { Length: > BodyLimits.NoteMax })
        {
            errors["note"] = [$"A anotação aceita até {BodyLimits.NoteMax} caracteres."];
        }

        if (request.ClientUpdatedAt is null || request.ClientUpdatedAt == default(DateTimeOffset))
        {
            errors["clientUpdatedAt"] = ["Informe o instante da escrita no aparelho."];
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        command = new UpsertBodyEntryCommand(
            userId,
            id,
            request.MeasuredOn!.Value,
            request.WeightKg,
            request.BodyFatPct,
            request.BodyFatPct is null ? null : request.FatMethod,
            request.WaistCm,
            request.NeckCm,
            request.HipCm,
            request.ArmCm,
            request.ThighCm,
            string.IsNullOrEmpty(note) ? null : note,
            TimeStamps.ToStorage(request.ClientUpdatedAt!.Value),
            request.Deleted);
        return errors;
    }

    private static void CheckCircumference(Dictionary<string, string[]> errors, string field, decimal? value)
    {
        if (value is { } cm && !BodyLimits.IsValidCircumference(cm))
        {
            errors[field] = [$"A medida deve ficar entre {BodyLimits.CircumferenceMinCm} e {BodyLimits.CircumferenceMaxCm} cm, com no máximo {BodyLimits.OneDecimalScale} casa decimal."];
        }
    }
}
