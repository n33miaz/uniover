using System.Globalization;
using System.Text;

namespace UniOver.Modules.Identity.Domain;

/// <summary>Por que um nome foi recusado (sem nunca repetir o que a pessoa digitou).</summary>
public enum DisplayNameError
{
    /// <summary>Vazio, só espaços, ou sem nenhuma letra, número ou emoji.</summary>
    Empty,

    /// <summary>Passou do limite de caracteres.</summary>
    TooLong,

    /// <summary>Tem caractere de controle, invisível, de direção de texto, sequência quebrada ou combinação em excesso.</summary>
    InvalidCharacters,
}

/// <summary>Resultado de normalizar um nome: o texto limpo ou o motivo da recusa.</summary>
public readonly record struct DisplayNameResult(string? Value, DisplayNameError? Error)
{
    public bool IsValid => Error is null;
}

/// <summary>
/// Como o nome de exibição é conferido e normalizado (o nome que a pessoa escolhe, aparece nas telas do dono e no
/// histórico). Regras, na ordem:
/// <list type="number">
/// <item>Normaliza em NFC (letra com acento vira um caractere só; evita dois nomes "iguais" que não comparam iguais).</item>
/// <item>Recusa texto com código inválido (substituto solto), caractere de controle (inclusive tab e quebra de linha),
/// separador de linha ou de parágrafo, uso privado e não atribuído.</item>
/// <item>Recusa caractere de FORMATO (categoria Cf): espaço de largura zero, junções, marcas de direção (LRM, RLM,
/// sobreposição e isolamento bidirecional: a "bandeira" que inverte o texto), hífen suave, marcas de tag e afins.
/// A ÚNICA exceção é a junção de largura zero (U+200D) ENTRE dois pictogramas, necessária para o emoji composto
/// (pessoa + profissão, família): ela não vale entre letras nem solta nas pontas. Sequências de tag (bandeiras de
/// subdivisão como a da Inglaterra) não são aceitas; as bandeiras de país, que usam indicadores regionais, são.</item>
/// <item>Recusa invisíveis que não são Cf mas ocupam lugar sem desenhar nada (preenchimentos do hangul, braille em
/// branco, junção de grafema, seletores de variação fora dos de emoji).</item>
/// <item>Recusa mais de 3 marcas combinantes seguidas (texto "zalgo" estoura a linha da tela).</item>
/// <item>Espaços (qualquer separador Zs, como o espaço sem quebra) viram um espaço comum; as pontas são aparadas e as
/// repetições colapsadas num só.</item>
/// <item>Conta o tamanho em PONTOS DE CÓDIGO Unicode (1 a 60), não em unidades UTF-16: um emoji conta 1 e o resultado
/// sempre cabe nos 100 caracteres da coluna.</item>
/// <item>Exige ao menos uma letra, número ou símbolo (emoji): só pontuação não é nome.</item>
/// </list>
/// Limitação conhecida: a junção sem largura (ZWNJ, U+200C), usada em persa e em algumas línguas indianas, é recusada.
/// </summary>
public static class DisplayNameRules
{
    public const int MaxLength = 60;
    public const int MaxCombiningRun = 3;

    // Entrada gigante nem chega a ser normalizada: a normalização é linear, mas não há motivo para gastá-la em lixo.
    // (60 pontos de código em NFC chegam a uns 3 vezes isso em NFD.)
    private const int MaxRawUnits = 512;

    private const int ZeroWidthJoiner = 0x200D;
    private const int VariationSelectorText = 0xFE0E;
    private const int VariationSelectorEmoji = 0xFE0F;

    public static DisplayNameResult Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new DisplayNameResult(null, DisplayNameError.Empty);
        }

        if (raw.Length > MaxRawUnits)
        {
            return new DisplayNameResult(null, DisplayNameError.TooLong);
        }

        string composed;
        try
        {
            composed = raw.Normalize(NormalizationForm.FormC);
        }
        catch (ArgumentException)
        {
            // Substituto solto (meio emoji): não é texto Unicode válido.
            return new DisplayNameResult(null, DisplayNameError.InvalidCharacters);
        }

        var runes = new List<Rune>(composed.Length);
        foreach (var rune in composed.EnumerateRunes())
        {
            runes.Add(rune);
        }

        var output = new StringBuilder(composed.Length);
        var count = 0;
        var combiningRun = 0;
        var visible = false;
        var pendingSpace = false;

        for (var i = 0; i < runes.Count; i++)
        {
            var rune = runes[i];
            var category = Rune.GetUnicodeCategory(rune);

            if (category == UnicodeCategory.SpaceSeparator)
            {
                // Só vira espaço se já houve texto antes (as pontas são aparadas); a repetição colapsa.
                pendingSpace = output.Length > 0;
                combiningRun = 0;
                continue;
            }

            if (IsForbidden(rune, category))
            {
                return new DisplayNameResult(null, DisplayNameError.InvalidCharacters);
            }

            if (category == UnicodeCategory.Format)
            {
                // Chegou aqui só a junção de largura zero (o resto de Cf foi recusado acima): precisa de pictograma dos dois lados.
                if (!IsPictographOnBothSides(runes, i))
                {
                    return new DisplayNameResult(null, DisplayNameError.InvalidCharacters);
                }
            }

            combiningRun = IsCombining(category) ? combiningRun + 1 : 0;
            if (combiningRun > MaxCombiningRun)
            {
                return new DisplayNameResult(null, DisplayNameError.InvalidCharacters);
            }

            if (pendingSpace)
            {
                output.Append(' ');
                count++;
                pendingSpace = false;
            }

            output.Append(rune.ToString());
            count++;
            visible |= IsVisibleText(category);
        }

        if (!visible || count == 0)
        {
            return new DisplayNameResult(null, DisplayNameError.Empty);
        }

        return count > MaxLength
            ? new DisplayNameResult(null, DisplayNameError.TooLong)
            : new DisplayNameResult(output.ToString(), null);
    }

    private static bool IsCombining(UnicodeCategory category) =>
        category is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark;

    private static bool IsVisibleText(UnicodeCategory category) =>
        category is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter
            or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter
            or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber
            or UnicodeCategory.MathSymbol or UnicodeCategory.CurrencySymbol or UnicodeCategory.ModifierSymbol or UnicodeCategory.OtherSymbol;

    private static bool IsForbidden(Rune rune, UnicodeCategory category)
    {
        switch (category)
        {
            case UnicodeCategory.Control:
            case UnicodeCategory.LineSeparator:
            case UnicodeCategory.ParagraphSeparator:
            case UnicodeCategory.PrivateUse:
            case UnicodeCategory.OtherNotAssigned:
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
