using System.Reflection;
using System.Text.Json;
using UniOver.Modules.Training.Contracts;

namespace UniOver.Modules.Training.Catalog;

/// <summary>Uma linha da semente do catálogo (já em português, reescrita por nós a partir do texto da origem).</summary>
internal sealed record SeedExercise(
    string SourceRef,
    string Slug,
    string Name,
    IReadOnlyList<string> Instructions,
    IReadOnlyList<string> PrimaryMuscles,
    IReadOnlyList<string> SecondaryMuscles,
    string Equipment,
    string RecordType,
    string? Level,
    string? Category,
    string? Mechanic,
    bool Reviewed,
    string SourceCommit,
    string Source = ExerciseSources.FreeExerciseDb);

/// <summary>O arquivo inteiro: a versão sobe sempre que o conteúdo muda, e é ela que dispara a recarga preguiçosa.</summary>
internal sealed record SeedDocument(int SeedVersion, string SourceCommit, IReadOnlyList<SeedExercise> Exercises);

/// <summary>
/// Lê a semente embutida no assembly. A leitura é preguiçosa (na primeira vez que alguém pede), nunca na partida: o
/// serviço não toca em nada, nem em arquivo, antes da primeira requisição de catálogo.
/// </summary>
internal sealed class CatalogSeedSource
{
    public const string ResourceName = "UniOver.Modules.Training.Catalog.Seed.exercises.pt-br.json";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly Lazy<SeedDocument> _document;

    public CatalogSeedSource() => _document = new(Read, LazyThreadSafetyMode.ExecutionAndPublication);

    /// <summary>Semente já pronta, para os testes simularem uma versão nova do catálogo sem mexer no arquivo embutido.</summary>
    internal CatalogSeedSource(SeedDocument document) => _document = new(document);

    public SeedDocument Document => _document.Value;

    /// <summary>Lê a semente embutida de novo, sem cache; é o que os testes de conteúdo usam.</summary>
    public static SeedDocument Read()
    {
        using var stream = typeof(CatalogSeedSource).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException("A semente do catálogo não está embutida no assembly.");
        return JsonSerializer.Deserialize<SeedDocument>(stream, JsonOptions)
            ?? throw new InvalidOperationException("A semente do catálogo está vazia.");
    }
}
