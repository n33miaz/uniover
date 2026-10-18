namespace UniOver.BuildingBlocks.Persistence;

/// <summary>Um módulo registrado: seu schema e o tipo do seu DbContext.</summary>
public sealed record ModuleDbContextRegistration(string Schema, Type ContextType);

/// <summary>
/// Lista (somente leitura depois da montagem) dos DbContexts de módulo. Quem migra ou inspeciona todos os
/// módulos lê daqui, sem varrer assemblies.
/// </summary>
public sealed class ModuleDbContextRegistry
{
    public ModuleDbContextRegistry(IEnumerable<ModuleDbContextRegistration> registrations)
    {
        ArgumentNullException.ThrowIfNull(registrations);
        var list = registrations.ToList();

        var duplicated = list.GroupBy(r => r.Schema, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1);
        if (duplicated is not null)
        {
            throw new InvalidOperationException($"O schema '{duplicated.Key}' foi registrado por mais de um módulo.");
        }

        Registrations = list;
    }

    public IReadOnlyList<ModuleDbContextRegistration> Registrations { get; }
}
