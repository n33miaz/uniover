namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// Regra da senha da conta do dono. Só o tamanho mínimo: a decisão é não exigir composição nem troca periódica
/// (nunca há expiração de senha). O teto é só proteção contra entrada gigante no hash.
/// </summary>
public static class PasswordPolicy
{
    public const int DefaultMinimumLength = 10;
    public const int MaximumLength = 256;

    /// <summary>Códigos de falha vazios quando a senha serve; os códigos nunca contêm a senha.</summary>
    public static IReadOnlyList<string> Validate(string? password, int minimumLength = DefaultMinimumLength)
    {
        if (string.IsNullOrEmpty(password))
        {
            return ["password-required"];
        }

        var errors = new List<string>();
        if (password.Length < minimumLength)
        {
            errors.Add("password-too-short");
        }

        if (password.Length > MaximumLength)
        {
            errors.Add("password-too-long");
        }

        return errors;
    }
}
