using AwesomeAssertions;
using UniOver.Modules.Tv.Features.PowerOff;

namespace UniOver.Modules.Tv.Tests.Validation;

public class PowerOffValidatorTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NoMode_KeepsTheBehaviorFromBefore(string? mode)
    {
        PowerOffValidator.TryParse(new PowerOffRequest(mode), out var safe).Should().BeTrue();
        safe.Should().BeFalse();
    }

    [Fact]
    public void NoBody_KeepsTheBehaviorFromBefore()
    {
        PowerOffValidator.TryParse(null, out var safe).Should().BeTrue();
        safe.Should().BeFalse();
    }

    [Fact]
    public void SafeMode_AsksForTheTurnOffWithReading()
    {
        PowerOffValidator.TryParse(new PowerOffRequest(" safe "), out var safe).Should().BeTrue();
        safe.Should().BeTrue();
    }

    [Theory]
    [InlineData("SAFE")]
    [InlineData("force")]
    [InlineData("off")]
    public void AnyOtherMode_IsRefused(string mode)
    {
        PowerOffValidator.TryParse(new PowerOffRequest(mode), out var safe).Should().BeFalse();
        safe.Should().BeFalse();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void ThePowerOffTimeout_MustBePositive(int seconds)
    {
        TvModuleOptions.IsValid(new TvModuleOptions { PowerOffTimeoutSeconds = seconds }).Should().BeFalse();
    }

    [Fact]
    public void ThePowerOffTimeout_IsLongEnoughForTheAgentToOpenTheSessionReadAndConfirm()
    {
        var options = new TvModuleOptions();

        options.PowerOffTimeout.Should().BeGreaterThan(options.HibernatingTimeout);
    }
}
