using System.Reflection;
using System.Text.RegularExpressions;

namespace UniOver.ArchitectureTests;

/// <summary>
/// Descobre os módulos pelo padrão de nome UniOver.Modules.*, para que módulos futuros entrem nas regras
/// sem editar os testes (basta o projeto de testes referenciá-los, o que o build já exige no Host).
/// </summary>
internal static partial class ModuleDiscovery
{
    public sealed record ModuleAssemblies(string Name, Assembly Interior, Assembly Contracts);

    [GeneratedRegex(@"^UniOver\.Modules\.(?<m>[A-Za-z0-9]+)(?<c>\.Contracts)?$")]
    private static partial Regex ModuleName();

    public static IReadOnlyList<ModuleAssemblies> DiscoveredModules { get; } = Discover();

    public static Assembly HostAssembly { get; } = typeof(Program).Assembly;

    // Pasta apps/api, achada subindo até o UniOver.slnx; serve para ler as referências de projeto.
    public static string ApiRoot { get; } = FindApiRoot();

    private static List<ModuleAssemblies> Discover()
    {
        var byName = Directory.GetFiles(AppContext.BaseDirectory, "UniOver.Modules.*.dll")
            .Select(f => Path.GetFileNameWithoutExtension(f))
            .Where(n => ModuleName().IsMatch(n))
            .ToDictionary(n => n, n => Assembly.Load(n));

        return byName.Keys
            .Select(n => ModuleName().Match(n))
            .Where(m => !m.Groups["c"].Success)
            .Select(m => m.Groups["m"].Value)
            .Distinct()
            .OrderBy(m => m, StringComparer.Ordinal)
            .Select(m => new ModuleAssemblies(
                m,
                byName[$"UniOver.Modules.{m}"],
                byName.TryGetValue($"UniOver.Modules.{m}.Contracts", out var c)
                    ? c
                    : throw new InvalidOperationException($"O módulo {m} não tem o projeto Contracts.")))
            .ToList();
    }

    private static string FindApiRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "UniOver.slnx")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new InvalidOperationException("UniOver.slnx não encontrado acima do diretório de testes.");
    }
}
