using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;

namespace UniOver.IntegrationTests.Training;

[Collection(PostgresGroup.Name)]
public sealed class ExerciseStepTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Guid FirstCatalogId() =>
        ExerciseIds.ForCatalog(ExerciseSources.FreeExerciseDb, CatalogSeedSource.Read().Exercises[0].SourceRef);

    private static Task<HttpResponseMessage> PutStepAsync(TrainingApp app, LoggedIn? login, Guid id, decimal? stepKg, DateTimeOffset at, Guid? key = null) =>
        app.SendAsync(HttpMethod.Put, $"/api/v1/training/exercises/{id}/step", new { stepKg, clientUpdatedAt = at }, login?.AccessToken, key ?? Guid.NewGuid());

    private static async Task<JsonElement> PulledAsync(TrainingApp app, LoggedIn login, Guid id, string? after = null)
    {
        var pages = after is null
            ? await app.PullAllPagesAsync(login, 500)
            : [await TrainingApp.JsonAsync(await app.PullAsync(login, after, 500))];
        return pages.SelectMany(p => p.GetProperty("items").EnumerateArray()).Single(i => i.GetProperty("id").GetGuid() == id).Clone();
    }

    /// <summary>O aparelho sempre puxa o catálogo antes de ajustar um salto; aqui a primeira leitura faz a carga da semente.</summary>
    private static async Task SeedAsync(TrainingApp app, LoggedIn login)
    {
        using var response = await app.PullAsync(login, limit: 1);
        response.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await PutStepAsync(app, null, Guid.NewGuid(), 2m, DateTimeOffset.UtcNow);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task StepOnACatalogRow_GoesToExerciseOverrides_AndThePullReturnsItMerged()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = FirstCatalogId();
        (await PulledAsync(app, login, id)).GetProperty("stepKg").ValueKind.Should().Be(JsonValueKind.Null, "sem escolha vale o do equipamento");

        using var response = await PutStepAsync(app, login, id, 1.25m, DateTimeOffset.UtcNow);
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("stepKg").GetDecimal().Should().Be(1.25m);
        await using var db = app.Db();
        var choice = await db.ExerciseOverrides.SingleAsync(o => o.ExerciseId == id, Ct);
        choice.UserId.Should().Be(TrainingApp.UserIdOf(login));
        choice.StepKg.Should().Be(1.25m);
        (await db.Exercises.SingleAsync(e => e.Id == id, Ct)).StepKg.Should().BeNull("a linha do catálogo não é tocada");
        (await PulledAsync(app, login, id)).GetProperty("stepKg").GetDecimal().Should().Be(1.25m);
    }

    [Fact]
    public async Task ChangingTheStep_MakesTheCatalogRowReappearInTheIncrementalPull()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = FirstCatalogId();
        var pages = await app.PullAllPagesAsync(login, 500);
        var cursor = pages[0].GetProperty("nextCursor").GetString()!;
        var firstStamp = pages[0].GetProperty("items").EnumerateArray().Single(i => i.GetProperty("id").GetGuid() == id).GetProperty("updatedAt").GetDateTimeOffset();

        using (await PutStepAsync(app, login, id, 4m, DateTimeOffset.UtcNow))
        {
        }

        var item = await PulledAsync(app, login, id, cursor);
        item.GetProperty("stepKg").GetDecimal().Should().Be(4m);
        item.GetProperty("updatedAt").GetDateTimeOffset().Should().BeAfter(firstStamp);
    }

    [Fact]
    public async Task NullStep_GoesBackToTheEquipmentStep()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        await SeedAsync(app, login);
        var id = FirstCatalogId();
        var now = DateTimeOffset.UtcNow;
        using (await PutStepAsync(app, login, id, 3m, now))
        {
        }

        using var reset = await PutStepAsync(app, login, id, null, now.AddSeconds(5));

        reset.StatusCode.Should().Be(HttpStatusCode.OK);
        (await PulledAsync(app, login, id)).GetProperty("stepKg").ValueKind.Should().Be(JsonValueKind.Null);
        await using var db = app.Db();
        (await db.ExerciseOverrides.SingleAsync(o => o.ExerciseId == id, Ct)).StepKg.Should().BeNull();
    }

    [Fact]
    public async Task OlderWrite_IsIgnored()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        await SeedAsync(app, login);
        var id = FirstCatalogId();
        var now = DateTimeOffset.UtcNow;
        using (await PutStepAsync(app, login, id, 5m, now))
        {
        }

        using var older = await PutStepAsync(app, login, id, 1m, now.AddMinutes(-2));

        older.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TrainingApp.JsonAsync(older)).GetProperty("stepKg").GetDecimal().Should().Be(5m);
        await using var db = app.Db();
        (await db.ExerciseOverrides.SingleAsync(o => o.ExerciseId == id, Ct)).StepKg.Should().Be(5m);
    }

    [Fact]
    public async Task Step_WorksOnTheUsersOwnExercise_TooAndOverridesTheRowValue()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now, stepKg: 2.5m)))
        {
        }

        using var response = await PutStepAsync(app, login, id, 1m, now.AddSeconds(1));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await PulledAsync(app, login, id)).GetProperty("stepKg").GetDecimal().Should().Be(1m);
    }

    [Fact]
    public async Task SameKey_ReplaysTheStoredResponse_AndFiftySimultaneousStepsLeaveOneRow()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        await SeedAsync(app, login);
        var id = FirstCatalogId();
        var at = DateTimeOffset.UtcNow;
        var key = Guid.NewGuid();

        using (var first = await PutStepAsync(app, login, id, 2m, at, key))
        {
            first.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using (var replay = await PutStepAsync(app, login, id, 2m, at, key))
        {
            replay.Headers.TryGetValues("Idempotent-Replayed", out var values).Should().BeTrue();
            values!.Should().Contain("true");
        }

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => PutStepAsync(app, login, id, 2m, at.AddSeconds(1))));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.ExerciseOverrides.CountAsync(o => o.ExerciseId == id, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task UnknownExercise_Returns404_AndAnotherUsersOwnExerciseToo()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var otherId = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        await using (var db = app.Db())
        {
            db.Exercises.Add(new Exercise
            {
                Id = otherId, Slug = "alheio", Source = ExerciseSources.Own, Name = "Alheio", OwnerUserId = Guid.NewGuid(),
                Equipment = Equipment.Other, PrimaryMuscles = [Muscle.Chest], CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            });
            await db.SaveChangesAsync(Ct);
        }

        using var unknown = await PutStepAsync(app, login, Guid.CreateVersion7(), 2m, now);
        using var foreign = await PutStepAsync(app, login, otherId, 2m, now);

        unknown.StatusCode.Should().Be(HttpStatusCode.NotFound);
        foreign.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task ClockAhead_Returns422_AndInvalidStepReturns400()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = FirstCatalogId();
        using (await app.PullAsync(login, limit: 1))
        {
        }

        using var ahead = await PutStepAsync(app, login, id, 2m, DateTimeOffset.UtcNow.AddHours(30));
        using var negative = await PutStepAsync(app, login, id, -1m, DateTimeOffset.UtcNow);

        ahead.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(ahead)).Should().EndWith("client-clock-ahead");
        negative.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
