using AwesomeAssertions;
using UniOver.Modules.Tv.Domain;

namespace UniOver.Modules.Tv.Tests.Domain;

// Os caracteres invisíveis são escritos sempre pelo escape de oito dígitos (\U0000XXXX): assim aparecem no código
// em vez de se esconderem nele (e nenhuma ferramenta os converte em silêncio no caractere de verdade).
public class LabelTextTests
{
    [Theory]
    [InlineData("\U0000202Eevil")]              // sobreposição da direita para a esquerda: inverte o que se lê
    [InlineData("TV\U0000202D")]                // sobreposição da esquerda para a direita
    [InlineData("a\U0000202Ab\U0000202C")]      // embutimento e fim de direção
    [InlineData("\U00002066x\U00002069")]       // isolamentos de direção
    [InlineData("a\U0000200Eb")]                // marca da esquerda para a direita
    [InlineData("a\U0000200Fb")]                // marca da direita para a esquerda
    [InlineData("a\U0000061Cb")]                // marca de letra árabe
    [InlineData("x\U0000200By")]                // espaço de largura zero
    [InlineData("x\U0000200Cy")]                // junção sem largura solta
    [InlineData("x\U0000200Dy")]                // junção de largura zero entre letras
    [InlineData("\U0000200Dx")]                 // junção no começo
    [InlineData("x\U0000200D")]                 // junção no fim
    [InlineData("a\U00002028b")]                // separador de linha
    [InlineData("a\U00002029b")]                // separador de parágrafo
    [InlineData("\U0000FEFFTV")]                // marca de ordem de byte
    [InlineData("a\U000000ADb")]                // hífen suave
    [InlineData("\U0001F3F4\U000E0067\U000E0062\U000E007F")] // sequência de tags (bandeira de subdivisão)
    [InlineData("a\tb")]
    [InlineData("a\nb")]
    [InlineData("a\r\nb")]
    [InlineData("a\U00000000b")]
    [InlineData("a\U00000085b")]
    [InlineData("\U00003164")]                  // preenchimento do hangul: desenha em branco
    [InlineData("\U00002800")]                  // braille em branco
    public void InvisibleControlAndDirectionCharacters_AreRefused(string text)
    {
        var result = LabelText.Normalize(text);

        result.IsValid.Should().BeFalse();
        result.Problem.Should().Be(LabelTextProblem.InvalidCharacters);
        result.Value.Should().BeEmpty("o texto recusado nunca volta");
    }

    [Fact]
    public void ALoneSurrogate_HalfAnEmoji_IsRefused()
    {
        var result = LabelText.Normalize("a" + (char)0xD83D + "b");

        result.Problem.Should().Be(LabelTextProblem.InvalidCharacters);
    }

    [Theory]
    [InlineData("TV da sala", "TV da sala")]
    [InlineData("Sala \U0001F4FA", "Sala \U0001F4FA")]
    [InlineData("\U0001F469\U0000200D\U0001F4BB", "\U0001F469\U0000200D\U0001F4BB")]            // pessoa + junção + computador: emoji composto
    [InlineData("\U00002764\U0000FE0F\U0000200D\U0001F525", "\U00002764\U0000FE0F\U0000200D\U0001F525")] // coração + seletor de emoji + junção + fogo
    [InlineData("\U0001F1E7\U0001F1F7", "\U0001F1E7\U0001F1F7")]                                  // bandeira de país (indicadores regionais)
    [InlineData("Cafe\U00000301", "Caf\U000000E9")]                                                 // NFD vira NFC
    [InlineData("  a   b  ", "a b")]
    [InlineData("a\U000000A0b", "a b")]                                                             // espaço sem quebra
    [InlineData("a\U00003000b", "a b")]                                                             // espaço ideográfico
    [InlineData("\U000000A0\U00003000x\U00002003", "x")]
    [InlineData("", "")]
    [InlineData("   ", "")]
    public void OrdinaryText_IsKept_WithSpacesAndAccentsNormalized(string text, string expected)
    {
        var result = LabelText.Normalize(text);

        result.IsValid.Should().BeTrue();
        result.Value.Should().Be(expected);
    }

    [Fact]
    public void NullIsEmpty()
    {
        var result = LabelText.Normalize(null);

        result.IsValid.Should().BeTrue();
        result.Value.Should().BeEmpty();
    }

    [Fact]
    public void GarbageTooBigToBeALabel_IsRefusedAsTooLong_WithoutBeingNormalized()
    {
        var result = LabelText.Normalize(new string('a', 5000));

        result.Problem.Should().Be(LabelTextProblem.TooLong);
        result.Value.Should().BeEmpty();
    }
}
