using AwesomeAssertions;
using UniOver.Modules.Devices.Domain;

namespace UniOver.Modules.Devices.Tests.Domain;

public class UserCodeTests
{
    [Fact]
    public void Generate_ProducesEightCharactersFromTheAlphabetOnly()
    {
        for (var i = 0; i < 500; i++)
        {
            var code = UserCode.Generate();

            code.Should().HaveLength(8);
            code.ToCharArray().Should().OnlyContain(c => UserCode.Alphabet.Contains(c, StringComparison.Ordinal));
        }
    }

    [Fact]
    public void Alphabet_HasNoVowelsAndNoAmbiguousCharacters()
    {
        UserCode.Alphabet.Should().NotMatchRegex("[AEIOU]", "vogais formariam palavras");
        UserCode.Alphabet.Should().NotMatchRegex("[01OIU]", "caracteres que se confundem");
        UserCode.Alphabet.Distinct().Should().HaveCount(UserCode.Alphabet.Length);
    }

    [Fact]
    public void Generate_DoesNotRepeatInAHundredDraws()
    {
        Enumerable.Range(0, 100).Select(_ => UserCode.Generate()).Distinct().Should().HaveCount(100);
    }

    [Fact]
    public void Format_ShowsTwoGroupsOfFour()
    {
        UserCode.Format("BCDFGHJK").Should().Be("BCDF-GHJK");
    }

    [Theory]
    [InlineData("BCDF-GHJK", "BCDFGHJK")]
    [InlineData("bcdf-ghjk", "BCDFGHJK")]
    [InlineData("  bcdf ghjk ", "BCDFGHJK")]
    [InlineData("BCDFGHJK", "BCDFGHJK")]
    public void Normalize_AcceptsTheDisplayedFormAndSloppyTyping(string input, string expected)
    {
        UserCode.Normalize(input).Should().Be(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("BCDF-GHJ")]
    [InlineData("BCDF-GHJKL")]
    [InlineData("BCDF-GHJA")]
    [InlineData("BCDF-GHJ0")]
    [InlineData("BCDF-GHJ!")]
    public void Normalize_RejectsWrongLengthOrCharactersOutsideTheAlphabet(string? input)
    {
        UserCode.Normalize(input).Should().BeNull();
    }
}

public class AgentSlugTests
{
    [Theory]
    [InlineData("PC Casa", "pc-casa")]
    [InlineData("pc-casa", "pc-casa")]
    [InlineData("Notebook da Sala (Windows)", "notebook-da-sala-windows")]
    [InlineData("Computador do Escritório", "computador-do-escritorio")]
    [InlineData("  --Casa--  ", "casa")]
    [InlineData("Casa   Grande", "casa-grande")]
    public void Derive_NormalizesTheName(string name, string expected)
    {
        AgentSlug.Derive(name).Should().Be(expected);
    }

    [Theory]
    [InlineData("")]
    [InlineData("!!")]
    [InlineData("ab")]
    [InlineData("日本語")]
    public void Derive_FallsBackWhenTheNameYieldsTooLittle(string name)
    {
        AgentSlug.Derive(name).Should().Be(AgentSlug.Fallback);
    }

    [Fact]
    public void Derive_NeverPassesFortyCharactersAndAlwaysMatchesTheEnvelopePattern()
    {
        var slug = AgentSlug.Derive(new string('a', 30) + " " + new string('b', 30));

        slug.Length.Should().BeLessThanOrEqualTo(AgentSlug.MaxLength);
        AgentSlug.IsValid(slug).Should().BeTrue();
        AgentSlug.IsValid(AgentSlug.Derive("Qualquer coisa! 123")).Should().BeTrue();
    }

    [Theory]
    [InlineData("pc-casa", true)]
    [InlineData("abc", true)]
    [InlineData("ab", false)]
    [InlineData("-abc", false)]
    [InlineData("abc-", false)]
    [InlineData("Abc", false)]
    [InlineData("a_c", false)]
    public void IsValid_FollowsTheDocumentedPattern(string slug, bool expected)
    {
        AgentSlug.IsValid(slug).Should().Be(expected);
    }

    [Fact]
    public void WithSuffix_KeepsTheFirstAndNumbersTheCollisionsFromTwo()
    {
        AgentSlug.WithSuffix("pc-casa", 1).Should().Be("pc-casa");
        AgentSlug.WithSuffix("pc-casa", 2).Should().Be("pc-casa-2");
        AgentSlug.WithSuffix("pc-casa", 3).Should().Be("pc-casa-3");
    }

    [Fact]
    public void WithSuffix_OnAMaximumLengthSlug_StaysInsideTheLimit()
    {
        var slug = new string('a', AgentSlug.MaxLength);

        var suffixed = AgentSlug.WithSuffix(slug, 12);

        suffixed.Length.Should().BeLessThanOrEqualTo(AgentSlug.MaxLength);
        suffixed.Should().EndWith("-12");
        AgentSlug.IsValid(suffixed).Should().BeTrue();
    }
}
