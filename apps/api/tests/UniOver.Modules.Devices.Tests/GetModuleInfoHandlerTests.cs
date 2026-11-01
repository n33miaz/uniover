using AwesomeAssertions;
using UniOver.Modules.Devices.Features.GetModuleInfo;

namespace UniOver.Modules.Devices.Tests;

public class GetModuleInfoHandlerTests
{
    [Fact]
    public void Handle_ReturnsTheModuleVersionAndTheAgentMessagesItAccepts()
    {
        var info = new GetModuleInfoHandler("1.2.3").Handle();

        info.Module.Should().Be("devices");
        info.Version.Should().Be("1.2.3");
        // O agente só declara e envia o diagnóstico se a API disser aqui que o aceita (rollout seguro).
        info.Features.Should().Contain("agent.diagnostics.v1");
    }
}
