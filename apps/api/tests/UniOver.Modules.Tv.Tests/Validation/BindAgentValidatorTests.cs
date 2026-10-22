using AwesomeAssertions;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Config;

namespace UniOver.Modules.Tv.Tests.Validation;

public class BindAgentValidatorTests
{
    [Theory]
    [InlineData("pc-casa")]
    [InlineData("a1b")]
    public void IsPlausibleSlug_AcceptsAnythingThatCouldBeAnAgent(string slug) =>
        BindAgentValidator.IsPlausibleSlug(slug).Should().BeTrue();

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void IsPlausibleSlug_RefusesEmptyText(string? slug) =>
        BindAgentValidator.IsPlausibleSlug(slug).Should().BeFalse();

    [Fact]
    public void IsPlausibleSlug_RefusesTextLongerThanTheLimit()
    {
        BindAgentValidator.IsPlausibleSlug(new string('a', ConfiguredTv.AgentSlugMax)).Should().BeTrue();
        BindAgentValidator.IsPlausibleSlug(new string('a', ConfiguredTv.AgentSlugMax + 1)).Should().BeFalse();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("TV da sala")]
    public void ValidateName_AcceptsAbsentEmptyAndOrdinaryNames(string? name) =>
        BindAgentValidator.ValidateName(name).Should().BeEmpty();

    [Fact]
    public void ValidateName_RefusesANameOverTheLimit_ButTrimsBeforeCounting()
    {
        BindAgentValidator.ValidateName(" " + new string('n', ConfiguredTv.NameMax) + " ").Should().BeEmpty();
        BindAgentValidator.ValidateName(new string('n', ConfiguredTv.NameMax + 1)).Should().ContainKey("name");
    }

    [Theory]
    [InlineData("\U0000202Eatv")]               // sobreposição da direita para a esquerda
    [InlineData("TV\U0000200Esala")]            // marca de direção
    [InlineData("TV\U0000200Bsala")]            // espaço de largura zero
    [InlineData("TV\U0000200Csala")]            // junção sem largura
    [InlineData("TV\U0000200Dsala")]            // junção de largura zero entre letras
    [InlineData("TV\U00002028sala")]            // separador de linha
    [InlineData("TV\U00002029sala")]            // separador de parágrafo
    [InlineData("\U0000FEFFTV")]                // marca de ordem de byte
    [InlineData("TV\U000E0067")]                // marca de tag
    public void ValidateName_RefusesInvisibleAndDirectionCharacters(string name)
    {
        BindAgentValidator.ValidateName(name, out var normalized).Should().ContainKey("name");
        normalized.Should().BeNull();
    }

    [Fact]
    public void ValidateName_PassesTheNormalizedNameOn_AndNothingWhenThereIsNone()
    {
        BindAgentValidator.ValidateName("  TV\U000000A0 da   sala ", out var spaced).Should().BeEmpty();
        BindAgentValidator.ValidateName("   ", out var blank).Should().BeEmpty();
        BindAgentValidator.ValidateName(null, out var none).Should().BeEmpty();

        spaced.Should().Be("TV da sala");
        blank.Should().BeNull("sem nome, a TV fica com o atual");
        none.Should().BeNull();
    }

    [Theory]
    [InlineData("TV\nsala")]
    [InlineData("TV\tsala")]
    [InlineData("TV\u0000sala")]
    [InlineData("TV\u0085sala")]
    public void ValidateName_RefusesControlCharacters(string name) =>
        BindAgentValidator.ValidateName(name).Should().ContainKey("name");
}
