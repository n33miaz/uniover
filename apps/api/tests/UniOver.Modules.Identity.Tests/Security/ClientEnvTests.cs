using AwesomeAssertions;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Security;

public class ClientEnvTests
{
    [Theory]
    [InlineData("iphone;standalone", "iphone", true)]
    [InlineData("iphone;browser", "iphone", false)]
    [InlineData("ipad;standalone", "ipad", true)]
    [InlineData("android;browser", "android", false)]
    [InlineData("pc;standalone", "pc", true)]
    [InlineData("  pc ;  browser  ", "pc", false)]
    public void Parse_AcceptsEachKnownDeviceAndMode(string value, string platform, bool installed) =>
        ClientEnv.Parse(value).Should().Be(new ClientEnvInfo(platform, installed));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("iphone")]
    [InlineData("iphone;")]
    [InlineData(";browser")]
    [InlineData("iphone;browser;extra")]
    [InlineData("iPhone;browser")]
    [InlineData("windows;browser")]
    [InlineData("iphone;installed")]
    [InlineData("iphone;STANDALONE")]
    [InlineData("<script>;browser")]
    public void Parse_IgnoresAnythingOutsideTheClosedList(string? value) =>
        ClientEnv.Parse(value).Should().BeNull();

    [Fact]
    public void Parse_IgnoresAHugeValueWithoutLookingAtIt() =>
        ClientEnv.Parse("iphone;" + new string('x', 5000)).Should().BeNull();
}
