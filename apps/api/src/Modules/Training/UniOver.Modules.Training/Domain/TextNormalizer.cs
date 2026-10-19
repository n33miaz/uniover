using System.Text;

namespace UniOver.Modules.Training.Domain;

/// <summary>
/// Normalização de texto de exercício: tira acento e caixa para comparar nomes e montar o <c>slug</c>. Feita à mão (e
/// não com <c>string.Normalize</c>) porque o Host roda com globalização invariante, onde a decomposição Unicode não é
/// garantida; o conjunto cobre as letras do português e as dos nomes que os dados de origem trazem.
/// </summary>
public static class TextNormalizer
{
    // Cada grupo diz de quais letras acentuadas sai a letra simples; fica em grupos para o par nunca desalinhar.
    private static readonly Dictionary<char, char> Folding = BuildFolding(
        ('a', "àáâãäåāăą"), ('c', "çćč"), ('d', "ď"), ('e', "èéêëēėęě"), ('i', "ìíîïīį"), ('l', "ł"),
        ('n', "ñńň"), ('o', "òóôõöøōő"), ('r', "ŕř"), ('s', "śšş"), ('t', "ť"), ('u', "ùúûüūůűų"),
        ('y', "ýÿ"), ('z', "źżž"));

    private static Dictionary<char, char> BuildFolding(params (char Plain, string Accented)[] groups)
    {
        var map = new Dictionary<char, char>();
        foreach (var (plain, accented) in groups)
        {
            foreach (var letter in accented)
            {
                map[letter] = plain;
            }
        }

        return map;
    }

    /// <summary>Minúsculas, sem acento e com os espaços colapsados; é a chave de comparação de nomes.</summary>
    public static string Fold(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(text.Length);
        var lastWasSpace = true;
        foreach (var raw in text.Trim())
        {
            var c = char.ToLowerInvariant(raw);
            if (Folding.TryGetValue(c, out var plain))
            {
                c = plain;
            }

            if (char.IsWhiteSpace(c))
            {
                if (!lastWasSpace)
                {
                    builder.Append(' ');
                }

                lastWasSpace = true;
                continue;
            }

            builder.Append(c);
            lastWasSpace = false;
        }

        return builder.ToString().TrimEnd();
    }

    /// <summary>Só letras e dígitos ASCII separados por hífen; vazio quando o nome não tem nenhum.</summary>
    public static string Slugify(string? text)
    {
        var folded = Fold(text);
        var builder = new StringBuilder(folded.Length);
        var pendingDash = false;
        foreach (var c in folded)
        {
            if (c is (>= 'a' and <= 'z') or (>= '0' and <= '9'))
            {
                if (pendingDash && builder.Length > 0)
                {
                    builder.Append('-');
                }

                pendingDash = false;
                builder.Append(c);
            }
            else
            {
                pendingDash = true;
            }
        }

        return builder.ToString();
    }

    /// <summary>
    /// <c>slug</c> de exercício próprio ou importado: o nome mais um sufixo curto do id, para o par (<c>source</c>,
    /// <c>slug</c>) continuar único mesmo com dois exercícios de nome igual.
    /// </summary>
    public static string SlugWithId(string name, Guid id)
    {
        var slug = Slugify(name);
        var suffix = id.ToString("N")[^8..];
        var room = 100 - suffix.Length - 1;
        if (slug.Length > room)
        {
            slug = slug[..room].TrimEnd('-');
        }

        return slug.Length == 0 ? suffix : $"{slug}-{suffix}";
    }
}
