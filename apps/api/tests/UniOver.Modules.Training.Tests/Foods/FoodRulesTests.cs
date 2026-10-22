using AwesomeAssertions;
using UniOver.Modules.Training.Domain.Foods;
using UniOver.Modules.Training.Features.Foods;

namespace UniOver.Modules.Training.Tests.Foods;

public sealed class FoodRulesTests
{
    [Fact]
    public void ExternalIds_AreDeterministicUuidV5sScopedBySource()
    {
        var first = ExternalFoodIds.Create("off", "12345678");
        var repeated = ExternalFoodIds.Create("off", "12345678");

        first.Should().Be(repeated);
        first.ToString("N")[12].Should().Be('5');
        ExternalFoodIds.Create("taco", "12345678").Should().NotBe(first);
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(10.25, true)]
    [InlineData(-0.01, false)]
    [InlineData(10.251, false)]
    public void MacroValues_AreNonNegativeAndHaveAtMostTwoDecimalPlaces(decimal value, bool valid) =>
        FoodRules.IsValidMacro(value).Should().Be(valid);

    [Theory]
    [InlineData("breakfast", true)]
    [InlineData("lunch", true)]
    [InlineData("snack", true)]
    [InlineData("dinner", true)]
    [InlineData("other", true)]
    [InlineData("brunch", false)]
    public void MealType_IsFromStableKnownSet(string value, bool valid) => MealTypes.IsValid(value).Should().Be(valid);
}
