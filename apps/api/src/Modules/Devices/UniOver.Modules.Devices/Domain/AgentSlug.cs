using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// O slug é o <c>agentId</c> que aparece no envelope (<c>agent:&lt;slug&gt;</c>) e no caminho do WebSocket: estável,
/// único e compatível com o padrão do envelope.
/// </summary>
public static partial class AgentSlug
{
    public const int MinLength = 3;

    public const int MaxLength = 40;

    public const string Fallback = "agent";

    [GeneratedRegex("^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex Pattern();

    public static bool IsValid(string? slug) => slug is not null && Pattern().IsMatch(slug);

    /// <summary>
    /// Deriva o slug do nome: sem acento, minúsculas, qualquer sequência fora de a-z e 0-9 vira um hífen. Nome que
    /// não rende ao menos três caracteres cai em <see cref="Fallback"/>.
    /// </summary>
    public static string Derive(string? name)
    {
        var decomposed = (name ?? string.Empty).Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(decomposed.Length);
        foreach (var c in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            var lower = char.ToLowerInvariant(c);
            if (lower is (>= 'a' and <= 'z') or (>= '0' and <= '9'))
            {
                builder.Append(lower);
            }
            else if (builder.Length > 0 && builder[^1] != '-')
            {
                builder.Append('-');
            }
        }

        var slug = builder.ToString().Trim('-');
        if (slug.Length > MaxLength)
        {
            slug = slug[..MaxLength].Trim('-');
        }

        return slug.Length >= MinLength ? slug : Fallback;
    }

    /// <summary>Candidato número <paramref name="attempt"/> (1 = o próprio slug; de 2 em diante ganha o sufixo <c>-2</c>, <c>-3</c>...).</summary>
    public static string WithSuffix(string slug, int attempt)
    {
        ArgumentNullException.ThrowIfNull(slug);
        if (attempt <= 1)
        {
            return slug;
        }

        var suffix = "-" + attempt.ToString(CultureInfo.InvariantCulture);
        var room = MaxLength - suffix.Length;
        var head = slug.Length > room ? slug[..room].Trim('-') : slug;
        return head + suffix;
    }
}
