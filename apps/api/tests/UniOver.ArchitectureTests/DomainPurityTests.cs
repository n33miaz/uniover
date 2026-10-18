using ArchUnitNET.Domain;
using ArchUnitNET.Loader;
using ArchUnitNET.xUnitV3;
using static ArchUnitNET.Fluent.ArchRuleDefinition;
using static UniOver.ArchitectureTests.ModuleDiscovery;

namespace UniOver.ArchitectureTests;

public class DomainPurityTests
{
    private static readonly Architecture Architecture = new ArchLoader()
        .LoadAssemblies(DiscoveredModules.SelectMany(m => new[] { m.Interior, m.Contracts }).ToArray())
        .Build();

    [Fact]
    public void DomainDoesNotReferenceInfrastructure()
    {
        // WithoutRequiringPositiveResults: hoje nenhum módulo tem Domain/; a regra vale assim que surgir.
        Types().That().ResideInNamespaceMatching(@"^UniOver\.Modules\.[^.]+\.Domain(\..*)?$")
            .Should().NotDependOnAnyTypesThat().ResideInNamespaceMatching(
                @"^(Microsoft\.EntityFrameworkCore|Microsoft\.AspNetCore|Npgsql|System\.Net\.Http)(\..*)?$")
            .WithoutRequiringPositiveResults()
            .Check(Architecture);
    }

    [Fact]
    public void HandlersDoNotUseHttpContext()
    {
        Types().That().HaveNameEndingWith("Handler")
            .Should().NotDependOnAnyTypesThat().HaveFullNameContaining("Microsoft.AspNetCore.Http.HttpContext")
            .WithoutRequiringPositiveResults()
            .Check(Architecture);
    }
}
