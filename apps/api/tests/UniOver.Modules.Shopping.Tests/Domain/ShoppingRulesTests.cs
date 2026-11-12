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

    [Theory]
    [InlineData(null, null, null)]
    [InlineData("", "Frios", "Frios")]
    [InlineData("Frios", null, "Frios")]
    [InlineData("leite", "Leite", "Leite")]
    [InlineData("Leite", "leite", "Leite")]
    public void Prefer_KeepsWhatExists_AndPicksTheSameOneInEitherOrder(string? first, string? second, string? expected) =>
        ShoppingRules.Prefer(first, second).Should().Be(expected);

    [Fact]
    public void Price_KeepsTheMostRecentlyTypedOne_WhateverTheArrivalOrder()
    {
        var early = DateTimeOffset.Parse("2026-11-12T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var late = early.AddMinutes(5);

        var inOrder = new PurchaseItem();
        ShoppingRules.Price(inOrder, 5m, early);
        ShoppingRules.Price(inOrder, 6m, late);

        var swapped = new PurchaseItem();
        ShoppingRules.Price(swapped, 6m, late);
        ShoppingRules.Price(swapped, 5m, early);

        inOrder.UnitPrice.Should().Be(6m);
        swapped.UnitPrice.Should().Be(6m);
        swapped.PricedAt.Should().Be(late);
    }

    [Fact]
    public void Price_OnATie_KeepsTheHigherOne_AndNoPriceOverNoPriceTellsNothing()
    {
        var at = DateTimeOffset.Parse("2026-11-12T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var line = new PurchaseItem();

        ShoppingRules.Price(line, null, at.AddHours(1));
        line.PricedAt.Should().BeNull("sem preço numa linha sem preço não ocupa o lugar de um preço digitado antes");

        ShoppingRules.Price(line, 4m, at);
        ShoppingRules.Price(line, 3m, at);
        line.UnitPrice.Should().Be(4m);

        ShoppingRules.Price(line, null, at.AddMinutes(1));
        line.UnitPrice.Should().BeNull("tirar o preço também é informar");
        ShoppingRules.Price(line, 9m, at);
        line.UnitPrice.Should().BeNull();
    }

    [Fact]
    public void ChangedAt_TakesTheDifferenceBetweenTheClocksOut_AndNeverGoesAheadOfTheServer()
    {
        var now = DateTimeOffset.Parse("2026-11-12T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

        // Relógio uma hora atrasado: a mudança de um minuto antes do envio é de um minuto antes de agora.
        ShoppingRules.ChangedAt(now.AddMinutes(-61), now.AddHours(-1), now).Should().Be(now.AddMinutes(-1));

        // Adiantado: idem, e nada passa de agora.
        ShoppingRules.ChangedAt(now.AddHours(2).AddMinutes(-5), now.AddHours(2), now).Should().Be(now.AddMinutes(-5));
        ShoppingRules.ChangedAt(now.AddHours(3), now.AddHours(2), now).Should().Be(now);

        // Sem a hora do envio (aparelho de versão anterior) ou sem a da mudança: vale a hora de chegada.
        ShoppingRules.ChangedAt(now.AddDays(-1), null, now).Should().Be(now);
        ShoppingRules.ChangedAt(null, now, now).Should().Be(now);
    }
}
