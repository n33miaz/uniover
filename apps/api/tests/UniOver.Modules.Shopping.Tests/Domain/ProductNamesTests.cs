using AwesomeAssertions;
using UniOver.Modules.Shopping.Domain;

namespace UniOver.Modules.Shopping.Tests.Domain;

public sealed class ProductNamesTests
{
    [Theory]
    [InlineData("  Açúcar   CRISTAL ", "acucar cristal")]
    [InlineData("Leite integral", "leite integral")]
    [InlineData("PÃO\tde\nFÔRMA", "pao de forma")]
    [InlineData("Arroz 5kg", "arroz 5kg")]
    public void Normalize_ProducesTheStableGroupKey(string input, string expected) =>
        ProductNames.Normalize(input).Should().Be(expected);

    [Fact]
    public void Normalize_GivesTheSameKey_ToNamesThatDifferOnlyByAccentCaseOrSpacing() =>
        ProductNames.Normalize("Feijão  Preto").Should().Be(ProductNames.Normalize(" feijao preto"));

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    public void Normalize_RejectsAnEmptyName(string input) =>
        FluentActions.Invoking(() => ProductNames.Normalize(input)).Should().Throw<ArgumentException>();
}
