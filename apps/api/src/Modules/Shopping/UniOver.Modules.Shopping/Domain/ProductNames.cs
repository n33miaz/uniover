using System.Globalization;
using System.Text;

namespace UniOver.Modules.Shopping.Domain;

/// <summary>
/// A chave do produto dentro do grupo: sem acento, sem diferença de caixa e sem espaço repetido, para que "Açúcar" e
/// "acucar " sejam o mesmo produto.
/// </summary>
public static class ProductNames
{
    public static string Normalize(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);

        var decomposed = value.Trim().Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(decomposed.Length);
        var pendingSpace = false;
        foreach (var character in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(character) == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            if (char.IsWhiteSpace(character))
            {
                pendingSpace = builder.Length > 0;
                continue;
            }

            if (pendingSpace)
            {
                builder.Append(' ');
                pendingSpace = false;
            }

            builder.Append(char.ToLowerInvariant(character));
        }

        return builder.ToString().Normalize(NormalizationForm.FormC);
    }
}
