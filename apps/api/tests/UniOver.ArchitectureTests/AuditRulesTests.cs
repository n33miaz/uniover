using System.Reflection;
using AwesomeAssertions;
using UniOver.SharedKernel.Audit;
using static UniOver.ArchitectureTests.ModuleDiscovery;

namespace UniOver.ArchitectureTests;

/// <summary>
/// Regras da trilha de auditoria. A leitura unificada só enxerga o que cada módulo expõe pela porta
/// <see cref="IAuditSource"/> (do SharedKernel); estas regras garantem que nenhuma tabela de auditoria fique de fora
/// dela e que a porta continue pura (sem infraestrutura).
/// </summary>
public class AuditRulesTests
{
    private static bool IsAuditEntity(Type type) =>
        type.Name.EndsWith("AuditEntry", StringComparison.Ordinal)
        && type.Namespace is { } ns
        && ns.StartsWith("UniOver.Modules.", StringComparison.Ordinal)
        && ns.Split('.').Contains("Domain");

    private static IEnumerable<Type> Sources(Assembly assembly) =>
        assembly.GetTypes().Where(t => t is { IsAbstract: false, IsInterface: false } && typeof(IAuditSource).IsAssignableFrom(t));

    [Fact]
    public void EveryModuleWithAnAuditEntity_RegistersAnAuditSourceInItsOwnInterior()
    {
        var withAuditTable = DiscoveredModules.Where(m => m.Interior.GetTypes().Any(IsAuditEntity)).ToList();

        withAuditTable.Select(m => m.Name).Should().Contain(["Identity", "Devices", "Tv"], "a regra só vale se enxerga os módulos que têm trilha");
        foreach (var module in withAuditTable)
        {
            Sources(module.Interior).Should().NotBeEmpty(
                $"{module.Name} tem uma entidade de auditoria e precisa expô-la ao administrador por IAuditSource");
        }
    }

    [Fact]
    public void AuditSources_LiveInsideTheirModuleInterior_NeverInContractsOrTheHost()
    {
        var outside = DiscoveredModules.Select(m => m.Contracts).Append(HostAssembly).SelectMany(Sources);

        outside.Should().BeEmpty("a fonte lê a tabela do módulo, que só o interior enxerga");
    }

    [Fact]
    public void TheAuditPort_LivesInTheSharedKernel_WhichKnowsNoFrameworkOrInfrastructure()
    {
        var references = typeof(IAuditSource).Assembly.GetReferencedAssemblies().Select(a => a.Name!);

        references.Where(n => n != "mscorlib" && n != "netstandard" && !n.StartsWith("System", StringComparison.Ordinal))
            .Should().BeEmpty("o SharedKernel é puro: a porta de auditoria não pode puxar EF Core, ASP.NET nem Npgsql");
    }
}
