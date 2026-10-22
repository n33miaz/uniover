using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Body;

namespace UniOver.Modules.Training.Features.Body.UpsertBodyProfile;

/// <summary>
/// Validação da borda do perfil. As mensagens dizem o limite, nunca o valor recebido (dado de saúde não vai para texto de
/// erro). Menor de 18 anos não é recusado aqui: o registro é livre e quem deixa de calcular é o aparelho.
/// </summary>
internal static class UpsertBodyProfileValidator
{
    public static Dictionary<string, string[]> Validate(
        UpsertBodyProfileRequest? request, Guid userId, DateOnly today, out UpsertBodyProfileCommand? command)
    {
        command = null;
        var errors = new Dictionary<string, string[]>();

        if (request is null)
        {
            errors["body"] = ["Informe o perfil no corpo da requisição."];
            return errors;
        }

        if (request.HeightCm is not { } height)
        {
            errors["heightCm"] = ["Informe a altura."];
        }
        else if (!BodyLimits.IsValidHeight(height))
        {
            errors["heightCm"] = [$"A altura deve ficar entre {BodyLimits.HeightMinCm} e {BodyLimits.HeightMaxCm} cm, com no máximo {BodyLimits.OneDecimalScale} casa decimal."];
        }

        if (request.BirthDate is not { } birthDate)
        {
            errors["birthDate"] = ["Informe a data de nascimento."];
        }
        else if (birthDate < BodyLimits.EarliestDate || birthDate > today)
        {
            errors["birthDate"] = ["A data de nascimento está fora do intervalo aceito."];
        }

        if (!BodySexes.IsValid(request.Sex))
        {
            errors["sex"] = [$"O sexo deve ser um destes: {string.Join(", ", BodySexes.All)}."];
        }

        var factor = request.ActivityFactor ?? BodyLimits.ActivityFactorDefault;
        if (!BodyLimits.IsValidActivityFactor(factor))
        {
            errors["activityFactor"] = [$"O fator de atividade deve ficar entre {BodyLimits.ActivityFactorMin} e {BodyLimits.ActivityFactorMax}, com no máximo {BodyLimits.ActivityFactorScale} casas decimais."];
        }

        if (request.ClientUpdatedAt is null || request.ClientUpdatedAt == default(DateTimeOffset))
        {
            errors["clientUpdatedAt"] = ["Informe o instante da escrita no aparelho."];
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        command = new UpsertBodyProfileCommand(
            userId,
            request.HeightCm!.Value,
            request.BirthDate!.Value,
            request.Sex!,
            factor,
            TimeStamps.ToStorage(request.ClientUpdatedAt!.Value));
        return errors;
    }
}
