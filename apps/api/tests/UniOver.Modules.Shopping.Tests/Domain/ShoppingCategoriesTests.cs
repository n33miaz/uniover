using AwesomeAssertions;
using UniOver.Modules.Shopping.Domain;

namespace UniOver.Modules.Shopping.Tests.Domain;

/// <summary>A mesma tabela e os mesmos casos do spec do app (`shopping-categories.spec.ts`): as duas pontas concordam.</summary>
public sealed class ShoppingCategoriesTests
{
    [Theory]
    [InlineData("Leite", "laticinios")]
    [InlineData("leite integral", "laticinios")]
    [InlineData("Leite condensado", "mercearia")]
    [InlineData("Creme de leite", "mercearia")]
    [InlineData("Papel higiênico", "higiene")]
    [InlineData("Sabão em pó", "limpeza")]
    [InlineData("Sabonete", "higiene")]
    [InlineData("Pão de queijo congelado", "congelados")]
    [InlineData("Pão de queijo", "padaria")]
    [InlineData("Bananas", "hortifruti")]
    [InlineData("OVOS brancos", "laticinios")]
    [InlineData("Água sanitária", "limpeza")]
    [InlineData("Água com gás", "bebidas")]
    [InlineData("Ração de gato", "pet")]
    [InlineData("Fralda G", "bebe")]
    [InlineData("Picanha", "carnes")]
    [InlineData("Salsa", "hortifruti")]
    [InlineData("Sal", "mercearia")]
    [InlineData("Chá gelado", "bebidas")]
    [InlineData("Pilhas AA", "outros")]
    [InlineData("", "outros")]
    public void Categorize_PicksTheLongestWholeKeyword(string name, string expected) =>
        ShoppingCategories.Categorize(name).Should().Be(expected);

    [Fact]
    public void TheTable_StartsInTheProduceAisle_AndEndsWithTheFallback()
    {
        ShoppingCategories.Keys.Should().HaveCount(12);
        ShoppingCategories.Keys[0].Should().Be("hortifruti");
        ShoppingCategories.Keys[^1].Should().Be(ShoppingCategories.Fallback);
        ShoppingCategories.IsKnown("pet").Should().BeTrue();
        ShoppingCategories.IsKnown("Pet").Should().BeFalse();
    }

    [Fact]
    public void ThePromotion_TravelsWithThePrice()
    {
        var line = new PurchaseItem();
        var at = DateTimeOffset.UnixEpoch;
        ShoppingRules.Price(line, 3.33m, at, new ShoppingRules.Promo(4.99m, "leve 3 pague 2"));
        line.RegularPrice.Should().Be(4.99m);
        line.PromoNote.Should().Be("leve 3 pague 2");

        ShoppingRules.Price(line, null, at.AddSeconds(1), new ShoppingRules.Promo(4.99m, "x"));
        line.UnitPrice.Should().BeNull();
        line.RegularPrice.Should().BeNull();
        line.PromoNote.Should().BeNull();
    }
}
