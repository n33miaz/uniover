using System.Globalization;
using System.Text;

namespace UniOver.Modules.Tv.Domain;

/// <summary>Por que um texto livre foi recusado (sem nunca repetir o que a pessoa digitou).</summary>
public enum LabelTextProblem
{
    None,

    /// <summary>Tem caractere de controle, invisível, de direção de texto, separador de linha ou sequência quebrada.</summary>
    InvalidCharacters,

    /// <summary>Grande demais para valer a pena normalizar (lixo).</summary>
    TooLong,
}

/// <summary>O texto limpo (vazio quando não sobrou nada) ou o motivo da recusa; <see cref="Value"/> é vazio quando recusado.</summary>
public readonly record struct LabelTextResult(string Value, LabelTextProblem Problem)
{
    public bool IsValid => Problem == LabelTextProblem.None;
}

/// <summary>
/// Como um texto livre da TV (o nome da TV e o rótulo próprio de um atalho) é conferido e normalizado. Esses textos
/// aparecem nas telas e na trilha, então não podem trazer caracteres que enganam o olho:
/// <list type="number">
/// <item>Normaliza em NFC (letra com acento vira um caractere só).</item>
/// <item>Recusa caractere de controle (inclusive tabulação e quebra de linha) e separador de linha ou de parágrafo
/// (U+2028 e U+2029).</item>
/// <item>Recusa caractere de FORMATO (categoria Cf): marcas de direção do texto (U+202E e todas as de bidirecional, que
/// invertem o que se lê), espaço de largura zero, junção sem largura (U+200C), marca de ordem de byte (U+FEFF), hífen
/// suave, marcas de tag e afins. A única exceção é a junção de largura zero (U+200D) ENTRE dois pictogramas, necessária
/// para o emoji composto: solta, nas pontas ou entre letras, é recusada.</item>
/// <item>Recusa os invisíveis que não são Cf mas ocupam lugar sem desenhar nada (preenchimentos do hangul, braille em
/// branco, junção de grafema, seletores de variação que não são os de emoji).</item>
/// <item>Qualquer separador de espaço (categoria Zs, como o espaço sem quebra) vira um espaço comum; as pontas são
/// aparadas e as repetições colapsadas num só.</item>
/// </list>
/// O tamanho máximo é de quem chama, medido no texto JÁ normalizado. A mesma ideia vale para o nome de exibição das
/// contas (módulo Identity); fica separada porque um módulo não enxerga o interior do outro.
/// </summary>
public static class LabelText
{
    // Entrada gigante nem chega a ser normalizada: nenhum rótulo legítimo chega perto disso.
    private const int MaxRawUnits = 512;

    private const int ZeroWidthJoiner = 0x200D;
    private const int VariationSelectorText = 0xFE0E;
    private const int VariationSelectorEmoji = 0xFE0F;

    public static LabelTextResult Normalize(string? raw)
    {
        if (string.IsNullOrEmpty(raw))
        {
            return new LabelTextResult(string.Empty, LabelTextProblem.None);
        }

        if (raw.Length > MaxRawUnits)
        {
            return Refused(LabelTextProblem.TooLong);
        }

        string composed;
        try
        {
            composed = raw.Normalize(NormalizationForm.FormC);
        }
        catch (ArgumentException)
        {
            // Substituto solto (meio emoji): não é texto Unicode válido.
            return Refused(LabelTextProblem.InvalidCharacters);
        }

        var runes = new List<Rune>(composed.Length);
        foreach (var rune in composed.EnumerateRunes())
        {
            runes.Add(rune);
        }

        var output = new StringBuilder(composed.Length);
        var pendingSpace = false;
        for (var i = 0; i < runes.Count; i++)
        {
            var rune = runes[i];
            var category = Rune.GetUnicodeCategory(rune);

            if (category == UnicodeCategory.SpaceSeparator)
            {
                // Só vira espaço se já houve texto antes (as pontas são aparadas); a repetição colapsa.
                pendingSpace = output.Length > 0;
                continue;
            }

            if (IsForbidden(rune, category) || (category == UnicodeCategory.Format && !IsPictographOnBothSides(runes, i)))
            {
                return Refused(LabelTextProblem.InvalidCharacters);
            }

            if (pendingSpace)
            {
                output.Append(' ');
                pendingSpace = false;
            }

            output.Append(rune.ToString());
        }

        return new LabelTextResult(output.ToString(), LabelTextProblem.None);
    }

    private static LabelTextResult Refused(LabelTextProblem problem) => new(string.Empty, problem);

    private static bool IsForbidden(Rune rune, UnicodeCategory category)
    {
        switch (category)
        {
            case UnicodeCategory.Control:
            case UnicodeCategory.LineSeparator:
            case UnicodeCategory.ParagraphSeparator:
            case UnicodeCategory.Surrogate:
                return true;
            case UnicodeCategory.Format:
                // A junção de largura zero é a única exceção; quem decide se ela está bem posicionada é o chamador.
                return rune.Value != ZeroWidthJoiner;
            default:
                return IsInvisibleFiller(rune.Value);
        }
    }

    private static bool IsInvisibleFiller(int value) => value switch
    {
        0x034F => true,                                 // junção de grafema
        0x115F or 0x1160 or 0x3164 or 0xFFA0 => true,   // preenchimentos do hangul
        0x17B4 or 0x17B5 => true,                       // vogais inerentes do khmer (não desenham nada)
        >= 0x180B and <= 0x180D => true,                // seletores de variação mongóis
        0x2800 => true,                                 // braille em branco
        0xFFFC or 0xFFFD => true,                       // objeto e substituto: não são texto
        >= 0xFE00 and <= 0xFE0D => true,                // seletores de variação que não são os de emoji
        >= 0xE0100 and <= 0xE01EF => true,              // seletores de variação suplementares
        _ => false,
    };

    private static bool IsPictographOnBothSides(List<Rune> runes, int joinerIndex)
    {
        // O seletor de emoji (U+FE0F) pode vir colado ao pictograma, antes da junção (ex.: coração + seletor + junção + fogo).
        var before = joinerIndex - 1;
        while (before >= 0 && (runes[before].Value is VariationSelectorEmoji or VariationSelectorText))
        {
            before--;
        }

        var after = joinerIndex + 1;
        return before >= 0 && after < runes.Count && IsPictograph(runes[before].Value) && IsPictograph(runes[after].Value);
    }

    /// <summary>Faixas de pictogramas (emoji e símbolos que os compõem). Aproximação estável, sem depender de dados de emoji.</summary>
    private static bool IsPictograph(int value) => value switch
    {
        0x00A9 or 0x00AE or 0x203C or 0x2049 or 0x2122 or 0x2139 => true,
        >= 0x2190 and <= 0x21FF => true,
        >= 0x2300 and <= 0x23FF => true,
        0x24C2 => true,
        >= 0x25A0 and <= 0x25FF => true,
        >= 0x2600 and <= 0x27BF => true,
        >= 0x2900 and <= 0x297F => true,
        >= 0x2B00 and <= 0x2BFF => true,
        0x3030 or 0x303D or 0x3297 or 0x3299 => true,
        >= 0x1F000 and <= 0x1FAFF => true,
        _ => false,
    };
}
