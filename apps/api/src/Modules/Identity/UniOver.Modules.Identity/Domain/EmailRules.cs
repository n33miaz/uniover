namespace UniOver.Modules.Identity.Domain;

public static class EmailRules
{
    public const int MaximumLength = 254;

    /// <summary>Forma mínima (uma arroba, nada vazio, sem espaço): a prova de que o e-mail existe nunca foi o objetivo.</summary>
    public static bool IsValid(string? email)
    {
        if (string.IsNullOrWhiteSpace(email) || email.Length > MaximumLength)
        {
            return false;
        }

        var at = email.IndexOf('@', StringComparison.Ordinal);
        return at > 0
            && at == email.LastIndexOf('@')
            && at < email.Length - 1
            && !email.Any(char.IsWhiteSpace);
    }

    /// <summary>Forma comparável: sem espaços nas pontas e em minúsculas (a coluna é única sobre este valor).</summary>
    public static string Normalize(string email)
    {
        ArgumentNullException.ThrowIfNull(email);
        return email.Trim().ToLowerInvariant();
    }
}
