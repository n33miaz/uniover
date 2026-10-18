using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Features.Login;

/// <summary>
/// Validação de forma na borda. A regra de tamanho mínimo da senha NÃO vale no login: ela é do cadastro, e
/// um login com senha curta deve falhar como qualquer senha errada, sem pista.
/// </summary>
internal static class LoginValidator
{
    public static Dictionary<string, string[]> Validate(LoginRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        // Espaços nas pontas (colar do e-mail, autopreenchimento) não invalidam: o handler normaliza.
        if (!EmailRules.IsValid(request?.Email?.Trim()))
        {
            errors["email"] = ["Informe um e-mail válido."];
        }

        if (string.IsNullOrEmpty(request?.Password) || request.Password.Length > PasswordPolicy.MaximumLength)
        {
            errors["password"] = ["Informe a senha."];
        }

        return errors;
    }
}
