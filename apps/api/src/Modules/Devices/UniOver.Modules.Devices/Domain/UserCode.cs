using System.Security.Cryptography;

namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// Código curto que o dono digita no app para aprovar o agente. O alfabeto não tem vogais (não forma palavra
/// ofensiva) nem os que se confundem entre si (sem 0 e 1, que lembram O e I).
/// </summary>
public static class UserCode
{
    public const string Alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";

    public const int Length = 8;

    /// <summary>Código novo, sem formatação, com sorteio sem viés.</summary>
    public static string Generate() => new(RandomNumberGenerator.GetItems<char>(Alphabet, Length));

    /// <summary>Forma exibida: <c>XXXX-XXXX</c>.</summary>
    public static string Format(string code)
    {
        ArgumentNullException.ThrowIfNull(code);
        return code.Length == Length ? $"{code[..4]}-{code[4..]}" : code;
    }

    /// <summary>
    /// Forma guardada: maiúsculas, sem hífen nem espaços. Nulo se o texto não é um código válido (tamanho ou
    /// caractere fora do alfabeto), para a borda tratar como código inexistente sem consultar o banco.
    /// </summary>
    public static string? Normalize(string? input)
    {
        if (string.IsNullOrWhiteSpace(input) || input.Length > 32)
        {
            return null;
        }

        var cleaned = new string([.. input.Where(c => c is not ('-' or ' '))]).ToUpperInvariant();
        return cleaned.Length == Length && cleaned.All(c => Alphabet.Contains(c, StringComparison.Ordinal)) ? cleaned : null;
    }
}
