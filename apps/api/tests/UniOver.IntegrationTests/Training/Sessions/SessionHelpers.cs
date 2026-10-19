using System.Text.Json;
using UniOver.IntegrationTests.Identity;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Domain.Sessions;

namespace UniOver.IntegrationTests.Training.Sessions;

/// <summary>Peças dos testes de treino ao vivo por cima do <see cref="TrainingApp"/> (que não é editado).</summary>
internal static class SessionHelpers
{
    public static readonly DateTimeOffset T0 = DateTimeOffset.UtcNow.AddHours(-2);

    private static readonly string[] Abdominals = ["abdominals"];
    private static readonly string[] Instructions = ["Faça."];

    public static Guid CatalogId(int index = 0) => Routines.RoutineHelpers.CatalogId(index);

    public static object SessionBody(
        DateTimeOffset clientUpdatedAt,
        DateTimeOffset? startedAt = null,
        DateTimeOffset? finishedAt = null,
        string deviceId = "aparelho-a",
        Guid? routineId = null,
        string? note = null,
        int? feeling = null,
        bool deleted = false) =>
        new
        {
            routineId,
            startedAt = startedAt ?? T0,
            finishedAt,
            note,
            feeling,
            deviceId,
            clientUpdatedAt,
            deleted,
        };

    public static object SetBody(
        DateTimeOffset clientUpdatedAt,
        Guid exerciseId,
        int position = 0,
        string setType = "work",
        decimal? weightKg = 80m,
        int? reps = 8,
        int? durationS = null,
        int? rir = null,
        decimal? rpe = null,
        string? note = null,
        DateTimeOffset? completedAt = null,
        bool deleted = false) =>
        new
        {
            exerciseId,
            position,
            setType,
            weightKg,
            reps,
            durationS,
            rir,
            rpe,
            note,
            completedAt = completedAt ?? clientUpdatedAt,
            clientUpdatedAt,
            deleted,
        };

    public static Task<HttpResponseMessage> PutSessionAsync(this TrainingApp app, LoggedIn? login, Guid id, object body, Guid? key = null) =>
        app.SendAsync(HttpMethod.Put, $"/api/v1/training/sessions/{id}", body, login?.AccessToken, key ?? Guid.NewGuid());

    public static Task<HttpResponseMessage> PutSetAsync(this TrainingApp app, LoggedIn? login, Guid sessionId, Guid id, object body, Guid? key = null) =>
        app.SendAsync(HttpMethod.Put, $"/api/v1/training/sessions/{sessionId}/sets/{id}", body, login?.AccessToken, key ?? Guid.NewGuid());

    /// <summary>Cria um exercício próprio com o tipo de registro pedido (o catálogo da semente é quase todo peso e repetições).</summary>
    public static async Task<Guid> CreateOwnExerciseAsync(this TrainingApp app, LoggedIn login, string recordType, string name = "Meu exercício")
    {
        var id = Guid.CreateVersion7();
        using var response = await app.PutCustomAsync(login, id, new
        {
            name,
            primaryMuscles = Abdominals,
            secondaryMuscles = Array.Empty<string>(),
            equipment = "bodyweight",
            recordType,
            stepKg = (decimal?)null,
            instructions = Instructions,
            clientUpdatedAt = DateTimeOffset.UtcNow,
            deleted = false,
        });
        response.EnsureSuccessStatusCode();
        return id;
    }

    /// <summary>Abre uma sessão e confere que o servidor aceitou.</summary>
    public static async Task<Guid> OpenSessionAsync(
        this TrainingApp app, LoggedIn login, DateTimeOffset? at = null, string deviceId = "aparelho-a", Guid? id = null)
    {
        var sessionId = id ?? Guid.CreateVersion7();
        using var response = await app.PutSessionAsync(login, sessionId, SessionBody(at ?? T0, deviceId: deviceId));
        response.EnsureSuccessStatusCode();
        return sessionId;
    }

    public static Task<HttpResponseMessage> PullResourceAsync(this TrainingApp app, LoggedIn? login, string resource, string? after = null, int? limit = null)
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

        var url = $"/api/v1/training/{resource}" + (query.Count > 0 ? "?" + string.Join('&', query) : string.Empty);
        return app.SendAsync(HttpMethod.Get, url, bearer: login?.AccessToken);
    }

    /// <summary>Lê todas as páginas até esgotar e devolve cada página como veio, em ordem.</summary>
    public static async Task<List<JsonElement>> PullAllAsync(this TrainingApp app, LoggedIn login, string resource, int limit)
    {
        var pages = new List<JsonElement>();
        string? cursor = null;
        for (var guard = 0; guard < 1000; guard++)
        {
            using var response = await app.PullResourceAsync(login, resource, cursor, limit);
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

        throw new InvalidOperationException("A leitura incremental não terminou.");
    }

    public static IEnumerable<JsonElement> Rows(this IEnumerable<JsonElement> pages) =>
        pages.SelectMany(p => p.GetProperty("items").EnumerateArray());

    public static Session NewSession(Guid userId, Guid? id = null, string device = "aparelho-a", DateTimeOffset? finishedAt = null, DateTimeOffset? deletedAt = null)
    {
        var now = DateTimeOffset.UtcNow;
        return new Session
        {
            Id = id ?? Guid.CreateVersion7(), UserId = userId, DeviceId = device, StartedAt = now.AddHours(-1), FinishedAt = finishedAt,
            CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now, DeletedAt = deletedAt,
        };
    }

    public static SessionSet NewSet(Guid userId, Guid sessionId, Guid exerciseId, int position = 0)
    {
        var now = DateTimeOffset.UtcNow;
        return new SessionSet
        {
            Id = Guid.CreateVersion7(), UserId = userId, SessionId = sessionId, ExerciseId = exerciseId, Position = position, SetType = SetTypes.Work,
            WeightKg = 50m, Reps = 10, CompletedAt = now, CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
        };
    }

    public static Routine NewRoutine(Guid userId, bool deleted = false)
    {
        var now = DateTimeOffset.UtcNow;
        return new Routine
        {
            Id = Guid.CreateVersion7(), UserId = userId, Name = "A", Position = 0, Active = true,
            CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now, DeletedAt = deleted ? now : null,
        };
    }
}
