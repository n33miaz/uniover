using System.Reflection;
using System.Xml.Linq;
using AwesomeAssertions;
using static UniOver.ArchitectureTests.ModuleDiscovery;

namespace UniOver.ArchitectureTests;

public class ModuleBoundaryTests
{
    private static IEnumerable<string> UniOverReferences(Assembly assembly) =>
        assembly.GetReferencedAssemblies()
            .Select(a => a.Name!)
            .Where(n => n.StartsWith("UniOver.", StringComparison.Ordinal));

    private static bool IsFrameworkAssembly(string name) =>
        name is "mscorlib" or "netstandard" || name.StartsWith("System", StringComparison.Ordinal);

    private static List<string> ProjectReferences(string csproj) =>
        XDocument.Load(csproj).Descendants("ProjectReference")
            .Select(e => Path.GetFileNameWithoutExtension(((string)e.Attribute("Include")!).Replace('\\', '/')))
            .ToList();

    [Fact]
    public void AtLeastTwoModulesAreDiscovered()
    {
        DiscoveredModules.Should().HaveCountGreaterThanOrEqualTo(2, "com um só módulo as regras passariam sem testar nada");
    }

    [Fact]
    public void ModuleInteriorReferencesOnlyAllowedAssemblies()
    {
        foreach (var module in DiscoveredModules)
        {
            var forbidden = UniOverReferences(module.Interior).Where(n =>
                n != "UniOver.SharedKernel"
                && !n.StartsWith("UniOver.BuildingBlocks.", StringComparison.Ordinal)
                && !(n.StartsWith("UniOver.Modules.", StringComparison.Ordinal) && n.EndsWith(".Contracts", StringComparison.Ordinal)));

            forbidden.Should().BeEmpty(
                $"o módulo {module.Name} só pode referenciar *.Contracts, SharedKernel e BuildingBlocks");
        }
    }

    [Fact]
    public void ModuleCsprojDoesNotReferenceOtherModuleInteriors()
    {
        // O compilador omite referência de projeto que nenhum tipo usa; por isso o csproj também é lido.
        foreach (var module in DiscoveredModules)
        {
            var csproj = Path.Combine(ApiRoot, "src", "Modules", module.Name, $"UniOver.Modules.{module.Name}", $"UniOver.Modules.{module.Name}.csproj");
            var references = ProjectReferences(csproj);

            references.Where(r => r.StartsWith("UniOver.Modules.", StringComparison.Ordinal)
                    && !r.EndsWith(".Contracts", StringComparison.Ordinal)
                    && r != $"UniOver.Modules.{module.Name}")
                .Should().BeEmpty($"{module.Name} não pode referenciar o interior de outro módulo");
            references.Should().NotContain("UniOver.Host");
        }
    }

    [Fact]
    public void ContractsDependOnlyOnSharedKernel()
    {
        foreach (var module in DiscoveredModules)
        {
            var references = module.Contracts.GetReferencedAssemblies().Select(a => a.Name!);

            references.Where(n => !IsFrameworkAssembly(n) && n != "UniOver.SharedKernel")
                .Should().BeEmpty($"{module.Name}.Contracts só pode depender do SharedKernel");
        }
    }

    [Fact]
    public void ContractsCsprojReferencesOnlySharedKernelAndNoPackages()
    {
        foreach (var module in DiscoveredModules)
        {
            var csproj = Path.Combine(ApiRoot, "src", "Modules", module.Name, $"UniOver.Modules.{module.Name}.Contracts", $"UniOver.Modules.{module.Name}.Contracts.csproj");

            ProjectReferences(csproj).Where(r => r != "UniOver.SharedKernel").Should().BeEmpty();
            XDocument.Load(csproj).Descendants("PackageReference").Should().BeEmpty();
        }
    }

    [Fact]
    public void EachModuleExposesAddAndMapEntryPoints()
    {
        foreach (var module in DiscoveredModules)
        {
            var type = module.Interior.GetType($"UniOver.Modules.{module.Name}.{module.Name}Module");
            type.Should().NotBeNull($"{module.Name} deve ter {module.Name}Module");
            type!.GetMethod($"Add{module.Name}Module", BindingFlags.Public | BindingFlags.Static).Should().NotBeNull();
            type.GetMethod($"Map{module.Name}Endpoints", BindingFlags.Public | BindingFlags.Static).Should().NotBeNull();
        }
    }

    [Fact]
    public void Host_ContainsNoRuleTypes()
    {
        // O Host só compõe: o único tipo próprio permitido é o Program (e o que o compilador gera).
        // Tipos fora do namespace UniOver vêm de ferramentas (ex.: a cobertura injeta um rastreador no assembly).
        var own = HostAssembly.GetTypes()
            .Where(t => t.Name != "Program" && !t.Name.Contains('<', StringComparison.Ordinal))
            .Where(t => t.Namespace is null || t.Namespace.StartsWith("UniOver", StringComparison.Ordinal))
            .Select(t => t.FullName);

        own.Should().BeEmpty("tipos de regra pertencem a módulos, não ao Host");
    }
}
