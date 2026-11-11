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
        info.Features.Should().Contain(["agent.diagnostics.v1", "tv.pair.v1", "tv.state.not_paired"]);
        info.Features.Should().Contain("tv.presence.v1", "o agente só declara a presença depois de a API a listar");
        info.Features.Should().Contain("tv.settings.open.v1", "o agente só declara a abertura de telas da TV depois de a API a listar");
        info.Features.Should().Contain("pc.rtc.v1", "o agente só declara o canal direto depois de a API o listar");
        info.Features.Should().Contain("tv.rtc.v1", "o agente só declara as teclas da TV pelo canal depois de a API listar");
        info.Features.Should().Contain("tv.state.waking", "o agente só conta que a TV está ligando depois de a API aceitar o valor");
        info.Features.Should().Contain("tv.state.adb_permission", "o agente só conta a permissão do ADB no estado depois de a API aceitar o campo");
        info.Features.Should().Contain("tv.adb.rebind.v1", "o agente só declara o refazer do registro do ADB depois de a API o listar");
        info.Features.Should().Contain("transport.restart.v1", "o agente só declara que entende o fechamento 4411 depois de a API o listar");
    }
}
