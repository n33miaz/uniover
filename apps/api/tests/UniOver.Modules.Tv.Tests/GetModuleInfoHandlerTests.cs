using AwesomeAssertions;
using UniOver.Modules.Tv.Features.GetModuleInfo;

namespace UniOver.Modules.Tv.Tests;

public class GetModuleInfoHandlerTests
{
    [Fact]
    public void Handle_ReturnsModuleNameAndConfiguredVersion()
    {
        var handler = new GetModuleInfoHandler("1.2.3");

        var info = handler.Handle();

        info.Module.Should().Be("tv");
        info.Version.Should().Be("1.2.3");
    }
}
