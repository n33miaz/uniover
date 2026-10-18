using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Features.CompletePasskeyRegistration;

/// <summary>Validação de forma na borda; a verificação criptográfica é do handler.</summary>
internal static class CompletePasskeyRegistrationValidator
{
    public static Dictionary<string, string[]> Validate(CompletePasskeyRegistrationRequest? request)
    {
        var errors = new Dictionary<string, string[]>();

        if (request?.ChallengeId is not { } id || id == Guid.Empty)
        {
            errors["challengeId"] = ["Informe o desafio recebido."];
        }

        if (request?.Credential?.Response is null)
        {
            errors["credential"] = ["Informe a credencial criada pelo autenticador."];
        }

        // Nome é opcional; se vier, precisa caber (vazio ou só espaços vale como ausente).
        if (!string.IsNullOrWhiteSpace(request?.Name) && PasskeyRules.NormalizeName(request.Name) is null)
        {
            errors["name"] = [$"Use até {PasskeyRules.MaxNameLength} caracteres."];
        }

        return errors;
    }
}
