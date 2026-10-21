using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace UniOver.Modules.Training.Features.Routines.ListRoutineTemplates;

/// <summary>Um exercício de um modelo, referenciado pelo <c>slug</c> do catálogo (o aparelho resolve o id).</summary>
internal sealed record RoutineTemplateItem(
    string ExerciseSlug,
    int TargetSets,
    int RepMin,
    int RepMax,
    int RestSeconds,
    int? SupersetGroup);

/// <summary>Um dia do modelo (A, B, C...): vira uma rotina quando o usuário escolhe o modelo.</summary>
internal sealed record RoutineTemplateRoutine(string Name, IReadOnlyList<RoutineTemplateItem> Items);

/// <summary>
/// Um modelo pronto: um programa com uma ou mais rotinas. É proposta nossa, não de fonte externa; o usuário edita à
/// vontade depois de criar.
/// </summary>
internal sealed record RoutineTemplate(string Id, string Name, string Description, IReadOnlyList<RoutineTemplateRoutine> Routines);

internal sealed record RoutineTemplatesResponse(IReadOnlyList<RoutineTemplate> Items);

/// <summary>
/// Lê os modelos embutidos no assembly. Só leitura e sem banco: a leitura é preguiçosa (na primeira vez que alguém pede),
/// nunca na partida.
/// </summary>
internal sealed class RoutineTemplateSource
{
    public const string ResourceName = "UniOver.Modules.Training.Catalog.Seed.routine-templates.json";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly Lazy<RoutineTemplatesResponse> _document;

    public RoutineTemplateSource() => _document = new(Read, LazyThreadSafetyMode.ExecutionAndPublication);

    public RoutineTemplatesResponse Document => _document.Value;

    /// <summary>Lê os modelos embutidos de novo, sem cache; é o que os testes de conteúdo usam.</summary>
    public static RoutineTemplatesResponse Read()
    {
        using var stream = typeof(RoutineTemplateSource).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException("Os modelos de rotina não estão embutidos no assembly.");
        return JsonSerializer.Deserialize<RoutineTemplatesResponse>(stream, JsonOptions)
            ?? throw new InvalidOperationException("O arquivo de modelos de rotina está vazio.");
    }
}

internal static class ListRoutineTemplatesEndpoint
{
    public static void MapListRoutineTemplates(this IEndpointRouteBuilder group) =>
        group.MapGet("/routine-templates", (RoutineTemplateSource source) => TypedResults.Ok(source.Document))
            .RequireAuthorization(TrainingAuth.Module)
            .Produces<RoutineTemplatesResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
}
