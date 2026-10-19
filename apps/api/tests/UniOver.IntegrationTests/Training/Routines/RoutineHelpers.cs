using System.Text.Json;
using UniOver.IntegrationTests.Identity;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;

namespace UniOver.IntegrationTests.Training.Routines;

/// <summary>Peças dos testes de rotina por cima do <see cref="TrainingApp"/> (que não é editado).</summary>
internal static class RoutineHelpers
{
    /// <summary>Id de um exercício da semente (o <c>index</c>-ésimo); existe depois da carga preguiçosa do catálogo.</summary>
    public static Guid CatalogId(int index = 0) =>
        ExerciseIds.ForCatalog(ExerciseSources.FreeExerciseDb, CatalogSeedSource.Read().Exercises[index].SourceRef);

    public static object Item(
        Guid? id, Guid exerciseId, int position, int sets = 3, int repMin = 8, int repMax = 12, int rest = 90, int? superset = null, string? note = null) =>
        new
        {
            id,
            exerciseId,
            position,
            targetSets = sets,
            repMin,
            repMax,
            restSeconds = rest,
            supersetGroup = superset,
            note,
        };

    public static object Body(
        DateTimeOffset clientUpdatedAt,
        IEnumerable<object>? items = null,
        string name = "A · Peito",
        int position = 0,
        bool active = true,
        string? note = null,
        bool deleted = false) =>
        new
        {
            name,
            position,
            active,
            note,
            items = (items ?? [Item(Guid.CreateVersion7(), CatalogId(0), 0)]).ToArray(),
            clientUpdatedAt,
            deleted,
        };

    public static Task<HttpResponseMessage> PutRoutineAsync(this TrainingApp app, LoggedIn? login, Guid id, object body, Guid? key = null) =>
        app.SendAsync(HttpMethod.Put, $"/api/v1/training/routines/{id}", body, login?.AccessToken, key ?? Guid.NewGuid());

    public static Task<HttpResponseMessage> PullRoutinesAsync(this TrainingApp app, LoggedIn? login, string? after = null, int? limit = null)
    {
        var query = new List<string>();
        if (after is not null)
        {
            query.Add("after=" + Uri.EscapeDataString(after));
        }

        if (limit is not null)
        {
            query.Add("limit=" + limit);
        }

        var url = "/api/v1/training/routines" + (query.Count > 0 ? "?" + string.Join('&', query) : string.Empty);
        return app.SendAsync(HttpMethod.Get, url, bearer: login?.AccessToken);
    }

    /// <summary>Lê todas as páginas até esgotar e devolve cada página como veio, em ordem.</summary>
    public static async Task<List<JsonElement>> PullAllRoutinePagesAsync(this TrainingApp app, LoggedIn login, int limit)
    {
        var pages = new List<JsonElement>();
        string? cursor = null;
        for (var guard = 0; guard < 1000; guard++)
        {
            using var response = await app.PullRoutinesAsync(login, cursor, limit);
            response.EnsureSuccessStatusCode();
            var page = await TrainingApp.JsonAsync(response);
            pages.Add(page.Clone());
            var items = page.GetProperty("items").GetArrayLength();
            var next = page.GetProperty("nextCursor").GetString();
            if (items == 0 || next is null || next == cursor)
            {
                return pages;
            }

            cursor = next;
        }

        throw new InvalidOperationException("A leitura incremental das rotinas não terminou.");
    }

    public static IEnumerable<JsonElement> Routines(this IEnumerable<JsonElement> pages) =>
        pages.SelectMany(p => p.GetProperty("items").EnumerateArray());
}
