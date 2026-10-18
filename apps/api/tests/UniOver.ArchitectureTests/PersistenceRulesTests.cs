using System.Reflection;
using AwesomeAssertions;
using UniOver.BuildingBlocks.Persistence;
using static UniOver.ArchitectureTests.ModuleDiscovery;

namespace UniOver.ArchitectureTests;

public class PersistenceRulesTests
{
    private static IEnumerable<Assembly> CandidateAssemblies =>
        DiscoveredModules.SelectMany(m => new[] { m.Interior, m.Contracts }).Append(HostAssembly);

    [Fact]
    public void EveryModuleDbContext_LivesInsideItsOwnModuleInterior()
    {
        // Descoberta genérica: hoje nenhum módulo tem DbContext; a regra passa a valer assim que surgir.
        var offenders = CandidateAssemblies
            .SelectMany(a => a.GetTypes())
            .Where(t => typeof(ModuleDbContext).IsAssignableFrom(t) && t != typeof(ModuleDbContext))
            .Where(t => !IsInsideModuleInterior(t))
            .Select(t => t.FullName);

        offenders.Should().BeEmpty("DbContext só mora em UniOver.Modules.<M>, nunca em Contracts nem no Host");
    }

    [Fact]
    public void ModuleDbContext_BaseIsNotUsedByContractsOrHost()
    {
        var contractsAndHost = DiscoveredModules.Select(m => m.Contracts).Append(HostAssembly);

        contractsAndHost.SelectMany(a => a.GetTypes())
            .Where(t => typeof(Microsoft.EntityFrameworkCore.DbContext).IsAssignableFrom(t))
            .Should().BeEmpty();
    }

    [Fact]
    public void Domain_DoesNotReferenceEntityFrameworkCore()
    {
        var offenders = DiscoveredModules.Select(m => m.Interior)
            .SelectMany(a => a.GetTypes())
            .Where(t => t.Namespace is not null && IsDomainNamespace(t.Namespace))
            .Where(t => ReferencedNamespaces(t).Any(n => n.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal)))
            .Select(t => t.FullName);

        offenders.Should().BeEmpty();
    }

    private static bool IsInsideModuleInterior(Type type) =>
        type.Namespace is { } ns
        && ns.StartsWith("UniOver.Modules.", StringComparison.Ordinal)
        && !ns.Split('.').Contains("Contracts");

    private static bool IsDomainNamespace(string ns) =>
        ns.StartsWith("UniOver.Modules.", StringComparison.Ordinal) && ns.Split('.').Contains("Domain");

    private static IEnumerable<string> ReferencedNamespaces(Type type)
    {
        const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        var types = type.GetFields(all).Select(f => f.FieldType)
            .Concat(type.GetProperties(all).Select(p => p.PropertyType))
            .Concat(type.GetMethods(all).SelectMany(m => m.GetParameters().Select(p => p.ParameterType).Append(m.ReturnType)))
            .Append(type.BaseType!)
            .Where(t => t is not null);
        return types.Select(t => t.Namespace ?? string.Empty);
    }
}
