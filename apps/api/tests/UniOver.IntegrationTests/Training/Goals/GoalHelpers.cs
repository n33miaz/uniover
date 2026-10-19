using System.Text.Json;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Training.Sessions;
using UniOver.Modules.Training.Domain.Goals;

namespace UniOver.IntegrationTests.Training.Goals;

/// <summary>Peças dos testes de metas por cima do <see cref="TrainingApp"/> (que não é editado).</summary>
internal static class GoalHelpers
{
    public static object GoalBody(DateTimeOffset clientUpdatedAt, decimal? value = 3m, Guid? exerciseId = null) =>
        new { exerciseId, value, clientUpdatedAt };

    public static Task<HttpResponseMessage> PutGoalAsync(this TrainingApp app, LoggedIn? login, string kind, object body, Guid? key = null) =>
        app.SendAsync(HttpMethod.Put, $"/api/v1/training/goals/{kind}", body, login?.AccessToken, key ?? Guid.NewGuid());

    public static Task<HttpResponseMessage> PullGoalsAsync(this TrainingApp app, LoggedIn? login, string? after = null, int? limit = null) =>
        app.PullResourceAsync(login, "goals", after, limit);

    public static Goal NewGoal(Guid userId, string kind = GoalKinds.WeeklySessions, Guid? exerciseId = null, decimal? value = 3m, DateTimeOffset? updatedAt = null, bool deleted = false)
    {
        var now = updatedAt ?? DateTimeOffset.UtcNow;
        return new Goal
        {
            Id = Guid.CreateVersion7(), UserId = userId, Kind = kind, ExerciseId = exerciseId, Value = deleted ? null : value,
            CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now, DeletedAt = deleted ? now : null,
        };
    }

    public static async Task<List<JsonElement>> PullAllGoalsAsync(this TrainingApp app, LoggedIn login, int limit) =>
        await app.PullAllAsync(login, "goals", limit);
}
