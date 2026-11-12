using System.Text.Json;

namespace UniOver.Modules.Shopping.Domain;

/// <summary>
/// As categorias de mercado (os corredores) e a regra que dá uma categoria ao nome de um produto. A tabela é a de
/// <c>contracts/shopping/categories.json</c>, embutida no assembly: o app usa uma cópia dela, conferida por spec, e as
/// duas pontas chegam à mesma categoria para o mesmo nome.
/// </summary>
public static class ShoppingCategories
{
    private const string Resource = "UniOver.Modules.Shopping.categories.json";

    private static readonly Lazy<Table> Data = new(Load);

    /// <summary>A categoria de quem não casa com nenhuma palavra.</summary>
    public static string Fallback => Data.Value.Fallback;

    /// <summary>As chaves, na ordem dos corredores.</summary>
    public static IReadOnlyList<string> Keys => Data.Value.Keys;

    public static bool IsKnown(string? key) => key is not null && Data.Value.Keys.Contains(key, StringComparer.Ordinal);

    /// <summary>
    /// A categoria do nome: a palavra-chave mais longa (em palavras, depois em letras) que aparece inteira no nome. Nome e
    /// palavra passam pela mesma normalização do produto e perdem o "s" final das palavras com mais de três letras, para o
    /// plural casar ("bananas", "ovos"). Sem nenhuma, <see cref="Fallback"/>.
    /// </summary>
    public static string Categorize(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return Fallback;
        }

        var words = Words(name);
        string? best = null;
        var bestWords = 0;
        var bestLength = 0;
        foreach (var (key, keyword) in Data.Value.Keywords)
        {
            if (keyword.Length < bestWords || !Contains(words, keyword))
            {
                continue;
            }

            var length = keyword.Sum(x => x.Length);
            if (keyword.Length > bestWords || length > bestLength)
            {
                best = key;
                bestWords = keyword.Length;
                bestLength = length;
            }
        }

        return best ?? Fallback;
    }

    internal static string[] Words(string value) =>
        ProductNames.Normalize(value)
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select(word => word.Length > 3 && word.EndsWith('s') ? word[..^1] : word)
            .ToArray();

    private static bool Contains(string[] words, string[] keyword)
    {
        for (var start = 0; start + keyword.Length <= words.Length; start++)
        {
            var match = true;
            for (var i = 0; i < keyword.Length && match; i++)
            {
                match = string.Equals(words[start + i], keyword[i], StringComparison.Ordinal);
            }

            if (match)
            {
                return true;
            }
        }

        return false;
    }

    private static Table Load()
    {
        using var stream = typeof(ShoppingCategories).Assembly.GetManifestResourceStream(Resource)
            ?? throw new InvalidOperationException("A tabela de categorias de Compras não foi embutida.");
        using var document = JsonDocument.Parse(stream);
        var root = document.RootElement;
        var keys = new List<string>();
        var keywords = new List<(string, string[])>();
        foreach (var category in root.GetProperty("categories").EnumerateArray())
        {
            var key = category.GetProperty("key").GetString()!;
            keys.Add(key);
            foreach (var keyword in category.GetProperty("keywords").EnumerateArray())
            {
                keywords.Add((key, Words(keyword.GetString()!)));
            }
        }

        return new Table(root.GetProperty("fallback").GetString()!, keys, keywords);
    }

    private sealed record Table(string Fallback, IReadOnlyList<string> Keys, IReadOnlyList<(string Key, string[] Words)> Keywords);
}
