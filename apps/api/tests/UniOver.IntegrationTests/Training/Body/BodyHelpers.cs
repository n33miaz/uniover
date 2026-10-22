using System.Globalization;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Training.Sessions;
using UniOver.Modules.Training.Domain.Body;

namespace UniOver.IntegrationTests.Training.BodyMetrics;

/// <summary>Peças dos testes do corpo por cima do <see cref="TrainingApp"/> (que não é editado).</summary>
internal static class BodyHelpers
{
    /// <summary>Hoje (UTC) como o corpo da requisição o escreve: <c>AAAA-MM-DD</c>.</summary>
    public static string Today(int plusDays = 0) =>
        DateOnly.FromDateTime(DateTime.UtcNow).AddDays(plusDays).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public static object EntryBody(
        DateTimeOffset clientUpdatedAt,
        string? measuredOn = null,
        decimal? weightKg = 82.4m,
        decimal? bodyFatPct = null,
        string? fatMethod = null,
        decimal? waistCm = null,
        decimal? neckCm = null,
        decimal? hipCm = null,
        decimal? armCm = null,
        decimal? thighCm = null,
        string? note = null,
        bool deleted = false) =>
        new
        {
            measuredOn = measuredOn ?? Today(),
            weightKg,
            bodyFatPct,
            fatMethod,
            waistCm,
            neckCm,
            hipCm,
            armCm,
            thighCm,
            note,
            clientUpdatedAt,
            deleted,
        };

    public static object ProfileBody(
        DateTimeOffset clientUpdatedAt,
        decimal? heightCm = 180m,
        string? birthDate = "1995-06-15",
        string? sex = "male",
        decimal? activityFactor = 1.55m) =>
        new { heightCm, birthDate, sex, activityFactor, clientUpdatedAt };

    public static Task<HttpResponseMessage> PutEntryAsync(this TrainingApp app, LoggedIn? login, Guid id, object body, Guid? key = null) =>
        app.SendAsync(HttpMethod.Put, $"/api/v1/training/body/entries/{id}", body, login?.AccessToken, key ?? Guid.NewGuid());

    public static Task<HttpResponseMessage> PutProfileAsync(this TrainingApp app, LoggedIn? login, object body, Guid? key = null) =>
        app.SendAsync(HttpMethod.Put, "/api/v1/training/body/profile", body, login?.AccessToken, key ?? Guid.NewGuid());

    public static Task<HttpResponseMessage> PullEntriesAsync(this TrainingApp app, LoggedIn? login, string? after = null, int? limit = null) =>
        app.PullResourceAsync(login, "body/entries", after, limit);

    public static Task<HttpResponseMessage> PullProfileAsync(this TrainingApp app, LoggedIn? login, string? after = null, int? limit = null) =>
        app.PullResourceAsync(login, "body/profile", after, limit);

    public static BodyEntry NewEntry(
        Guid userId, decimal? weightKg = 80m, DateTimeOffset? updatedAt = null, bool deleted = false, DateOnly? measuredOn = null)
    {
        var now = updatedAt ?? DateTimeOffset.UtcNow;
        return new BodyEntry
        {
            Id = Guid.CreateVersion7(),
            UserId = userId,
            MeasuredOn = measuredOn ?? DateOnly.FromDateTime(DateTime.UtcNow),
            WeightKg = deleted ? null : weightKg,
            CreatedAt = now,
            UpdatedAt = now,
            ClientUpdatedAt = now,
            DeletedAt = deleted ? now : null,
        };
    }

    public static BodyProfile NewProfile(Guid userId, DateTimeOffset? updatedAt = null)
    {
        var now = updatedAt ?? DateTimeOffset.UtcNow;
        return new BodyProfile
        {
            UserId = userId,
            HeightCm = 175m,
            BirthDate = new DateOnly(1990, 1, 1),
            Sex = BodySexes.Female,
            ActivityFactor = 1.4m,
            CreatedAt = now,
            UpdatedAt = now,
            ClientUpdatedAt = now,
        };
    }
}
