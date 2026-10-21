using AwesomeAssertions;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Tests.Domain;

public class DisplayNameRulesTests
{
    private static string Ok(string input)
    {
        var result = DisplayNameRules.Normalize(input);
        result.Error.Should().BeNull($"'{Escape(input)}' deveria ser aceito");
        return result.Value!;
    }

    private static DisplayNameError Refused(string? input)
    {
        var result = DisplayNameRules.Normalize(input);
        result.Value.Should().BeNull($"'{Escape(input)}' deveria ser recusado");
        return result.Error!.Value;
    }

    private static string Escape(string? text) =>
        text is null ? "null" : string.Concat(text.Select(c => c is < ' ' or > '~' ? $"\\u{(int)c:X4}" : c.ToString()));

    [Theory]
    [InlineData("Neemias", "Neemias")]
    [InlineData("Alice", "Alice")]
    [InlineData("  Raphael  ", "Raphael")]
    [InlineData("José da Silva", "José da Silva")]
    [InlineData("Maria-Clara D'Ávila Jr.", "Maria-Clara D'Ávila Jr.")]
    [InlineData("山田 太郎", "山田 太郎")]
    [InlineData("Zoë", "Zoë")]
    [InlineData("Ana 2", "Ana 2")]
    [InlineData("😀", "😀")]
    [InlineData("Ana 🔥", "Ana 🔥")]
    public void Accepts_OrdinaryNames(string input, string expected) => Ok(input).Should().Be(expected);

    [Fact]
    public void Trims_AndCollapsesRepeatedSpaces_IncludingNoBreakAndIdeographicSpaces()
    {
        Ok("  Ana    Maria  ").Should().Be("Ana Maria");
        Ok("Ana\u00A0\u00A0Maria").Should().Be("Ana Maria", "o espaço sem quebra vira um espaço comum");
        Ok("Ana\u3000Maria").Should().Be("Ana Maria");
        Ok("\u00A0 Ana").Should().Be("Ana");
    }

    [Fact]
    public void NormalizesToNfc_SoTheSameNameAlwaysComparesEqual()
    {
        var decomposed = "Jose\u0301";
        var composed = "José";

        Ok(decomposed).Should().Be(composed);
        Ok(decomposed).Length.Should().Be(4);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\u00A0\u3000")]
    public void Refuses_EmptyOrOnlySpaces(string input) => Refused(input).Should().Be(DisplayNameError.Empty);

    [Fact]
    public void Refuses_NullAsEmpty() => Refused(null).Should().Be(DisplayNameError.Empty);

    [Theory]
    [InlineData("...")]
    [InlineData("- -")]
    [InlineData("\u0301")]
    public void Refuses_ANameWithNoLetterNumberOrSymbol(string input) => Refused(input).Should().Be(DisplayNameError.Empty);

    [Theory]
    [InlineData("Ana\u0001")]
    [InlineData("Ana\tMaria")]
    [InlineData("Ana\nMaria")]
    [InlineData("Ana\rMaria")]
    [InlineData("\nAna")]
    [InlineData("Ana\u007F")]
    [InlineData("Ana\u0085")]
    [InlineData("Ana\u001B[31m")]
    public void Refuses_ControlCharacters_EvenAtTheEnds(string input) =>
        Refused(input).Should().Be(DisplayNameError.InvalidCharacters);

    [Theory]
    [InlineData("Ana\u2028Maria")]
    [InlineData("Ana\u2029Maria")]
    public void Refuses_LineAndParagraphSeparators(string input) =>
        Refused(input).Should().Be(DisplayNameError.InvalidCharacters);

    [Theory]
    [InlineData("Ana\u200BMaria")] // espaço de largura zero
    [InlineData("Ana\u200CMaria")] // junção sem largura
    [InlineData("Ana\u200DMaria")] // junção de largura zero entre letras
    [InlineData("Ana\u2060Maria")] // junção de palavra
    [InlineData("\uFEFFAna")] // marca de ordem de bytes / espaço sem largura
    [InlineData("Ana\u00ADMaria")] // hífen suave
    [InlineData("Ana\u200E")] // marca esquerda-direita
    [InlineData("Ana\u200F")] // marca direita-esquerda
    [InlineData("Ana\u061C")] // marca de letra árabe
    public void Refuses_InvisibleFormatCharacters(string input) =>
        Refused(input).Should().Be(DisplayNameError.InvalidCharacters);

    [Theory]
    [InlineData("\u202EAna")] // sobreposição direita-esquerda: inverte o resto do texto
    [InlineData("Ana\u202D")]
    [InlineData("Ana\u202A")]
    [InlineData("Ana\u202B")]
    [InlineData("Ana\u202C")]
    [InlineData("\u2066Ana\u2069")] // isolamentos bidirecionais
    [InlineData("\u2067Ana")]
    [InlineData("\u2068Ana")]
    public void Refuses_BidirectionalOverridesAndIsolates(string input) =>
        Refused(input).Should().Be(DisplayNameError.InvalidCharacters);

    [Theory]
    [InlineData("Anaㅤ")] // preenchimento do hangul
    [InlineData("Anaᅟ")]
    [InlineData("Anaᅠ")]
    [InlineData("Anaﾠ")]
    [InlineData("Ana⠀")] // braille em branco
    [InlineData("Ana\u034F")] // junção de grafema
    [InlineData("Ana\uFE00")] // seletor de variação que não é de emoji
    [InlineData("Ana￼")]
    [InlineData("Ana�")]
    public void Refuses_InvisibleFillersThatAreNotFormatCharacters(string input) =>
        Refused(input).Should().Be(DisplayNameError.InvalidCharacters);

    [Fact]
    public void Refuses_TagCharacters_ThatCanSmuggleInvisibleText()
    {
        var tags = char.ConvertFromUtf32(0xE0041) + char.ConvertFromUtf32(0xE007F);

        Refused("Ana" + tags).Should().Be(DisplayNameError.InvalidCharacters);
        Refused("🏴" + tags).Should().Be(DisplayNameError.InvalidCharacters);
    }

    [Fact]
    public void Refuses_PrivateUseAndUnassignedCodePoints()
    {
        Refused("Ana\uE000").Should().Be(DisplayNameError.InvalidCharacters);
        Refused("Ana" + char.ConvertFromUtf32(0xF0000)).Should().Be(DisplayNameError.InvalidCharacters);
        Refused("Ana￿").Should().Be(DisplayNameError.InvalidCharacters);
    }

    [Fact]
    public void Refuses_LoneSurrogates_WithoutThrowing()
    {
        // Montados em tempo de execução: um substituto solto não é texto Unicode válido (nem cabe num atributo).
        var halfEmojiAtTheEnd = new string(['A', 'n', 'a', '\uD83D']);
        var halfEmojiAtTheStart = new string(['\uDE00', 'A', 'n', 'a']);
        var swappedPair = new string(['A', '\uDE00', '\uD83D', 'a']);

        foreach (var input in new[] { halfEmojiAtTheEnd, halfEmojiAtTheStart, swappedPair })
        {
            var act = () => DisplayNameRules.Normalize(input);

            act.Should().NotThrow();
            Refused(input).Should().Be(DisplayNameError.InvalidCharacters);
        }
    }

    [Fact]
    public void ZeroWidthJoiner_IsAllowedOnlyBetweenPictographs_ForComposedEmoji()
    {
        var womanTechnologist = "\U0001F469\u200D\U0001F4BB"; // pessoa + notebook
        var family = "\U0001F468\u200D\U0001F469\u200D\U0001F467\u200D\U0001F466";
        var heartOnFire = "❤\uFE0F\u200D\U0001F525"; // o seletor de emoji vem colado ao coração, antes da junção

        Ok(womanTechnologist).Should().Be(womanTechnologist);
        Ok(family).Should().Be(family);
        Ok(heartOnFire).Should().Be(heartOnFire);
        Ok("Ana " + womanTechnologist).Should().Be("Ana " + womanTechnologist);
    }

    [Theory]
    [InlineData("\u200D\U0001F469")] // solta no começo
    [InlineData("\U0001F469\u200D")] // solta no fim
    [InlineData("\U0001F469\u200D\u200D\U0001F4BB")] // duas seguidas
    [InlineData("\U0001F469 \u200D\U0001F4BB")] // depois de um espaço
    [InlineData("A\u200D\U0001F4BB")] // letra antes
    [InlineData("\U0001F469\u200DA")] // letra depois
    public void ZeroWidthJoiner_IsRefusedAnywhereElse(string input) =>
        Refused(input).Should().Be(DisplayNameError.InvalidCharacters);

    [Fact]
    public void Length_IsCountedInCodePoints_OneToSixty()
    {
        Ok(new string('a', DisplayNameRules.MaxLength)).Should().HaveLength(DisplayNameRules.MaxLength);
        Refused(new string('a', DisplayNameRules.MaxLength + 1)).Should().Be(DisplayNameError.TooLong);

        // Um emoji fora do plano básico tem 2 unidades UTF-16 mas é 1 caractere: 60 deles cabem.
        var sixtyEmoji = string.Concat(Enumerable.Repeat("\U0001F600", DisplayNameRules.MaxLength));
        Ok(sixtyEmoji).Should().Be(sixtyEmoji);
        Refused(sixtyEmoji + "\U0001F600").Should().Be(DisplayNameError.TooLong);
    }

    [Fact]
    public void Length_CountsCodePoints_SoTheResultAlwaysFitsTheHundredCharacterColumn()
    {
        // Pior caso aceito: 60 pontos de código, mesmo em emoji composto, nunca passam de 100 caracteres no banco.
        var composed = string.Concat(Enumerable.Repeat("\U0001F469\u200D\U0001F4BB", 20));

        Ok(composed).EnumerateRunes().Count().Should().Be(60);
        Refused(composed + "\U0001F469").Should().Be(DisplayNameError.TooLong);
    }

    [Fact]
    public void Length_IsCheckedAfterCollapsingSpaces_AndAbsurdInputIsRefusedWithoutWork()
    {
        Ok("a" + new string(' ', 400) + "b").Should().Be("a b");
        Refused(new string('a', 100_000)).Should().Be(DisplayNameError.TooLong);
    }

    [Fact]
    public void Refuses_Zalgo_MoreThanThreeCombiningMarksInARow()
    {
        // O "x" não tem forma composta com estas marcas, então a normalização não mexe no texto.
        Ok("x\u0301\u0302\u0303").Should().Be("x\u0301\u0302\u0303");
        Refused("x\u0301\u0302\u0303\u0304").Should().Be(DisplayNameError.InvalidCharacters);
        Refused("Z" + string.Concat(Enumerable.Repeat("\u0336", 30))).Should().Be(DisplayNameError.InvalidCharacters);
    }

    [Fact]
    public void KeycapEmoji_AreStillAccepted()
    {
        Ok("1\uFE0F\u20E3").Should().Be("1\uFE0F\u20E3");
    }

    [Fact]
    public void Normalizing_AnAlreadyNormalizedName_ChangesNothing()
    {
        foreach (var name in new[] { "Ana Maria", "José", "\U0001F469\u200D\U0001F4BB", "山田 太郎" })
        {
            var once = Ok(name);

            Ok(once).Should().Be(once);
        }
    }

    [Fact]
    public void User_SetDisplayName_StoresTheNormalizedText_AndMarksItConfirmed()
    {
        var now = new DateTimeOffset(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
        var user = User.CreateGuest("alice@uniover.test", "Convite", "hash", now);
        user.IsDisplayNameConfirmed.Should().BeFalse("o nome veio do convite, a pessoa ainda não escolheu");

        user.SetDisplayName("  Alice   Souza ", now.AddMinutes(1));

        user.DisplayName.Should().Be("Alice Souza");
        user.DisplayNameConfirmedAt.Should().Be(now.AddMinutes(1));
        user.IsDisplayNameConfirmed.Should().BeTrue();
    }

    [Fact]
    public void User_SetDisplayName_RefusesWhatTheRulesRefuse_AndKeepsTheOldName()
    {
        var now = new DateTimeOffset(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
        var user = User.Create("dono@uniover.test", "dono", "hash", now);

        var act = () => user.SetDisplayName("Ana\u200BMaria", now);

        act.Should().Throw<ArgumentException>();
        user.DisplayName.Should().Be("dono");
        user.DisplayNameConfirmedAt.Should().BeNull();
    }
}
