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
    [InlineData("TV\nsala")]
    [InlineData("TV\tsala")]
    [InlineData("TV\u0000sala")]
    [InlineData("TV\u0085sala")]
    public void ValidateName_RefusesControlCharacters(string name) =>
        BindAgentValidator.ValidateName(name).Should().ContainKey("name");
}
