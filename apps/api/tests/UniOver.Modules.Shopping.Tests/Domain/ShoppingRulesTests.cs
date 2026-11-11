using AwesomeAssertions;
using UniOver.Modules.Shopping.Domain;

namespace UniOver.Modules.Shopping.Tests.Domain;

public sealed class ShoppingRulesTests
{
    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("   ", null)]
    [InlineData("  Mercado  ", "Mercado")]
    public void Clean_TrimsAndTurnsEmptyIntoAbsent(string? input, string? expected) =>
        ShoppingRules.Clean(input).Should().Be(expected);

    [Fact]
    public void Fits_AcceptsAbsentAndTheExactLimit_AndRejectsOneMore()
    {
        ShoppingRules.Fits(null, 3).Should().BeTrue();
        ShoppingRules.Fits("abc", 3).Should().BeTrue();
        ShoppingRules.Fits("abcd", 3).Should().BeFalse();
    }

    [Theory]
    [InlineData("0.001", true)]
    [InlineData("1", true)]
    [InlineData("999999.999", true)]
    [InlineData("0", false)]
    [InlineData("-1", false)]
    [InlineData("1000000", false)]
    public void IsQuantity_IsPositiveAndFitsTheColumn(string value, bool expected) =>
        ShoppingRules.IsQuantity(decimal.Parse(value, System.Globalization.CultureInfo.InvariantCulture)).Should().Be(expected);

    [Theory]
    [InlineData(null, true)]
    [InlineData("0", true)]
    [InlineData("9999999.99", true)]
    [InlineData("-0.01", false)]
    [InlineData("10000000", false)]
    public void IsMoney_IsOptional_NeverNegative_AndFitsTheColumn(string? value, bool expected) =>
        ShoppingRules.IsMoney(value is null ? null : decimal.Parse(value, System.Globalization.CultureInfo.InvariantCulture)).Should().Be(expected);
}
