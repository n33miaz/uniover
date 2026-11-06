using AwesomeAssertions;
using UniOver.Modules.Tv.Features.Pair;

namespace UniOver.Modules.Tv.Tests.Validation;

public class PairValidatorTests
{
    [Theory]
    [InlineData("A1B2C3")]
    [InlineData("a1b2c3")]
    [InlineData("000000")]
    [InlineData("FFFFFF")]
    public void ACodeInTheTvFormat_IsValid(string code) =>
        PairValidator.Validate(new PairRequest(code)).Should().BeEmpty();

    [Fact]
    public void NoCodeMeansTheFirstStep_AndIsValid()
    {
        PairValidator.Validate(new PairRequest(null)).Should().BeEmpty();
        PairValidator.Validate(null).Should().BeEmpty();
    }

    [Fact]
    public void CancellingAlone_IsValid_ButNotTogetherWithACode()
    {
        PairValidator.Validate(new PairRequest(null, true)).Should().BeEmpty();
        PairValidator.Validate(new PairRequest(null, false)).Should().BeEmpty();
        PairValidator.Validate(new PairRequest("A1B2C3", false)).Should().BeEmpty();
        PairValidator.Validate(new PairRequest("A1B2C3", true)).Should().ContainKey("cancel");
    }

    [Fact]
    public void TheMinimumIntervalBetweenCodeRequests_IsTenSeconds() =>
        PairThrottle.MinimumInterval.Should().Be(TimeSpan.FromSeconds(10));

    [Theory]
    [InlineData("")]
    [InlineData("A1B2C")]
    [InlineData("A1B2C3D")]
    [InlineData("G1B2C3")]
    [InlineData("A1 B2C")]
    [InlineData("A1B2C3\n")]
    public void ACodeOutsideTheTvFormat_IsRefused(string code) =>
        PairValidator.Validate(new PairRequest(code)).Should().ContainKey("code");
}
