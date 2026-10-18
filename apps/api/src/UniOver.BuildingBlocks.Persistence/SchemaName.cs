using System.Text.RegularExpressions;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>Validação de identificadores SQL que não podem ser parâmetros (schema e nome de papel).</summary>
internal static partial class SchemaName
{
    [GeneratedRegex("^[a-z][a-z0-9_]{1,40}$")]
    private static partial Regex Pattern();

    public static void EnsureValid(string? value, string parameterName = "schema")
    {
        if (value is null || !Pattern().IsMatch(value))
        {
            throw new ArgumentException(
                "Identificador inválido: use minúsculas, dígitos e sublinhado (2 a 41 caracteres), começando por letra.",
                parameterName);
        }
    }
}
