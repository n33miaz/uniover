using AwesomeAssertions;
using static UniOver.ArchitectureTests.ModuleDiscovery;

namespace UniOver.ArchitectureTests;

/// <summary>
/// Prova que a descoberta enxerga os módulos reais. Os testes genéricos de fronteira só valem se os assemblies
/// são carregados; um módulo que o Host não referencia some da varredura e as regras passariam sem testá-lo.
/// </summary>
public class ModuleDiscoveryTests
{
    [Fact]
    public void AtLeastThreeModulesAreDiscovered_IdentityTvAndDevices()
    {
        var names = DiscoveredModules.Select(m => m.Name).ToList();

        names.Should().HaveCountGreaterThanOrEqualTo(3);
        names.Should().Contain(["Identity", "Tv", "Devices"]);
    }

    [Fact]
    public void EachDiscoveredModule_HasItsInteriorAndItsContractsAssemblies()
    {
        foreach (var module in DiscoveredModules)
        {
            module.Interior.GetName().Name.Should().Be($"UniOver.Modules.{module.Name}");
            module.Contracts.GetName().Name.Should().Be($"UniOver.Modules.{module.Name}.Contracts");
        }
    }

    [Fact]
    public void WebSocketTransport_IsRecognizedAsAnAdapterOfDevices_NotAsAModule()
    {
        const string adapter = "UniOver.Modules.Devices.Transport.WebSocket";

        // O adaptador é carregado pelo Host (referência de projeto); o nome diz de qual módulo ele é adaptador.
        File.Exists(Path.Combine(AppContext.BaseDirectory, adapter + ".dll"))
            .Should().BeTrue("o Host referencia o adaptador de transporte do Devices");
        adapter.Should().StartWith("UniOver.Modules.Devices.Transport.");

        DiscoveredModules.Select(m => m.Name).Should().NotContain("Transport", "adaptador não é módulo");
        DiscoveredModules.Select(m => m.Interior.GetName().Name).Should().NotContain(adapter);
        DiscoveredModules.Should().ContainSingle(m => m.Name == "Devices");
    }
}
