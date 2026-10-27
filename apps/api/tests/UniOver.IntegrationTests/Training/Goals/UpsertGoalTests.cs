using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Goals;
using static UniOver.IntegrationTests.Training.Goals.GoalHelpers;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.Goals;

[Collection(PostgresGroup.Name)]
public sealed class UpsertGoalTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PutGoalAsync(null, "weekly_sessions", GoalBody(DateTimeOffset.UtcNow));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Put_CreatesTheWeeklyGoal_WithAServerGeneratedIdAndTheOwnersUser()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(DateTimeOffset.UtcNow, 3m));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("kind").GetString().Should().Be("weekly_sessions");
        body.GetProperty("value").GetDecimal().Should().Be(3m);
        body.GetProperty("exerciseId").ValueKind.Should().Be(JsonValueKind.Null);
        body.GetProperty("deleted").GetBoolean().Should().BeFalse();
        var id = body.GetProperty("id").GetGuid();
        id.ToString()[14].Should().Be('7', "o id é um UUID v7 gerado no servidor");
        await using var db = app.Db();
        var row = await db.Set<Goal>().SingleAsync(g => g.Id == id, Ct);
        row.UserId.Should().Be(TrainingApp.UserIdOf(login));
        row.Value.Should().Be(3m);
    }

    [Fact]
    public async Task Put_CreatesTheE1rmGoalOfAnExercise_AndTheCatalogIsSeededLazily()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var exercise = CatalogId(0);

        using var response = await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(DateTimeOffset.UtcNow, 55m, exercise));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("exerciseId").GetGuid().Should().Be(exercise);
        body.GetProperty("value").GetDecimal().Should().Be(55m);
    }

    [Fact]
    public async Task SameKey_SameBody_ReturnsTheStoredResponse_WithoutExecutingAgain()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();
        var body = GoalBody(DateTimeOffset.UtcNow, 4m);

        using var first = await app.PutGoalAsync(login, "weekly_sessions", body, key);
        using var second = await app.PutGoalAsync(login, "weekly_sessions", body, key);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(first).Should().BeFalse();
        Replayed(second).Should().BeTrue();
        (await second.Content.ReadAsStringAsync(Ct)).Should().Be(await first.Content.ReadAsStringAsync(Ct));
        await using var db = app.Db();
        (await db.Set<Goal>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task TheSameBodyWithANewKey_IsStillIdempotent_AndLeavesTheRowUntouched()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = GoalBody(DateTimeOffset.UtcNow, 4m);
        using (await app.PutGoalAsync(login, "weekly_sessions", body))
        {
        }

        Goal before;
        await using (var db = app.Db())
        {
            before = await db.Set<Goal>().SingleAsync(Ct);
        }

        using var again = await app.PutGoalAsync(login, "weekly_sessions", body);

        again.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = app.Db();
        var after = await check.Set<Goal>().SingleAsync(Ct);
        after.Id.Should().Be(before.Id);
        after.UpdatedAt.Should().Be(before.UpdatedAt);
    }

    [Fact]
    public async Task SameKey_DifferentBody_Returns422KeyReused_AndMissingKeyRunsWithoutReplay()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now, 3m), key))
        {
        }

        using var reused = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now, 5m), key);
        using var missing = await app.SendAsync(HttpMethod.Put, "/api/v1/training/goals/weekly_sessions", GoalBody(now, 3m), login.AccessToken);

        reused.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(reused)).Should().EndWith("idempotency-key-reused");
        missing.StatusCode.Should().Be(HttpStatusCode.OK, "sem chave a escrita segue sem proteção, nesta transição");
        missing.Headers.Contains("Idempotent-Replayed").Should().BeFalse();
    }

    [Theory]
    [InlineData("weekly_sessions", false)]
    [InlineData("daily_kcal", false)]
    [InlineData("exercise_e1rm", true)]
    public async Task FiftySimultaneousPuts_WithTheSameKey_LeaveOneRow_AndNoServerError(string kind, bool withExercise)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();
        var body = GoalBody(DateTimeOffset.UtcNow, kind == "daily_kcal" ? 2200m : 5m, withExercise ? CatalogId(0) : null);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutGoalAsync(login, kind, body, key)));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK || r.StatusCode == HttpStatusCode.Conflict);
        responses.Should().Contain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Set<Goal>().CountAsync(Ct)).Should().Be(1);
    }

    [Theory]
    [InlineData("weekly_sessions", false)]
    [InlineData("daily_kcal", false)]
    [InlineData("exercise_e1rm", true)]
    public async Task FiftySimultaneousPuts_WithFiftyDifferentKeys_LeaveOneRow_AndAllSucceed(string kind, bool withExercise)
    {
        // Sem a chave em comum, o que segura as duplicatas é a chave natural (inclusive sem exercício) e o handler que relê.
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = GoalBody(DateTimeOffset.UtcNow, kind == "daily_kcal" ? 2200m : 5m, withExercise ? CatalogId(0) : null);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutGoalAsync(login, kind, body, Guid.NewGuid())));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK, "nenhum envio perde: quem perde a corrida relê e conclui");
        await using var db = app.Db();
        (await db.Set<Goal>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithDifferentValuesAndClocks_LeaveOneRow_HoldingTheNewestWrite()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(i =>
            app.PutGoalAsync(login, "weekly_sessions", GoalBody(now.AddSeconds(i), 1 + (i % 14)))));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        var row = await db.Set<Goal>().SingleAsync(Ct);
        row.ClientUpdatedAt.Should().Be(TimeStamps.ToStorage(now.AddSeconds(49)));
        row.Value.Should().Be(1 + (49 % 14));
    }

    [Fact]
    public async Task ANewerPut_ReplacesTheValue_KeepingTheSameRowAndId()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        using var first = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now, 3m));
        var firstId = (await TrainingApp.JsonAsync(first)).GetProperty("id").GetGuid();

        using var second = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now.AddMinutes(1), 4m));
        var body = await TrainingApp.JsonAsync(second);

        body.GetProperty("id").GetGuid().Should().Be(firstId);
        body.GetProperty("value").GetDecimal().Should().Be(4m);
        await using var db = app.Db();
        (await db.Set<Goal>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task OlderPut_IsIgnored_AndTheStoredGoalComesBack()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now, 4m)))
        {
        }

        using var old = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now.AddMinutes(-5), 2m));
        var body = await TrainingApp.JsonAsync(old);

        old.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("value").GetDecimal().Should().Be(4m);
    }

    [Fact]
    public async Task NullValue_IsATombstone_ANewerValueBringsItBack_AndAnOlderOneDoesNot()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now, 4m)))
        {
        }

        using var removed = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now.AddMinutes(1), null));
        var removedBody = await TrainingApp.JsonAsync(removed);
        using var older = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now.AddSeconds(30), 5m));
        var olderBody = await TrainingApp.JsonAsync(older);

        removedBody.GetProperty("deleted").GetBoolean().Should().BeTrue();
        removedBody.GetProperty("value").ValueKind.Should().Be(JsonValueKind.Null);
        olderBody.GetProperty("deleted").GetBoolean().Should().BeTrue("a lápide mais nova vence a edição mais velha");
        await using (var db = app.Db())
        {
            var row = await db.Set<Goal>().SingleAsync(Ct);
            row.IsDeleted.Should().BeTrue();
            row.Value.Should().BeNull();
        }

        using var back = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now.AddMinutes(2), 6m));
        var backBody = await TrainingApp.JsonAsync(back);

        backBody.GetProperty("deleted").GetBoolean().Should().BeFalse();
        backBody.GetProperty("value").GetDecimal().Should().Be(6m);
        await using var check = app.Db();
        (await check.Set<Goal>().CountAsync(Ct)).Should().Be(1, "a mesma chave natural volta a usar a mesma linha");
    }

    [Fact]
    public async Task TombstoneOfAGoalThatNeverArrived_CreatesADeletedRow_AndAnOlderEditAfterItIsIgnored()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        using var tombstone = await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(now, null, CatalogId(2)));
        using var older = await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(now.AddMinutes(-1), 55m, CatalogId(2)));

        tombstone.StatusCode.Should().Be(HttpStatusCode.OK);
        older.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TrainingApp.JsonAsync(older)).GetProperty("deleted").GetBoolean().Should().BeTrue();
        await using var db = app.Db();
        var row = await db.Set<Goal>().SingleAsync(Ct);
        row.IsDeleted.Should().BeTrue();
        row.Value.Should().BeNull();
    }

    [Fact]
    public async Task DifferentExercisesOfTheSameKind_AreDifferentGoals()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        using (await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(now, 55m, CatalogId(0))))
        {
        }

        using (await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(now, 80m, CatalogId(1))))
        {
        }

        using (await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now, 3m)))
        {
        }

        await using var db = app.Db();
        (await db.Set<Goal>().CountAsync(Ct)).Should().Be(3);
    }

    [Theory]
    [InlineData("weekly_sessions", 0)]
    [InlineData("weekly_sessions", 15)]
    [InlineData("weekly_sessions", -1)]
    [InlineData("daily_kcal", 499)]
    [InlineData("daily_kcal", 10001)]
    public async Task ValueOutsideTheKindsRange_Returns400WithTheField(string kind, decimal value)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutGoalAsync(login, kind, GoalBody(DateTimeOffset.UtcNow, value));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await TrainingApp.JsonAsync(response)).GetProperty("errors").TryGetProperty("value", out _).Should().BeTrue();
    }

    [Fact]
    public async Task ValueOutsideTheE1rmRange_AndTheShapeOfTheKey_AreRefused()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        using var zero = await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(now, 0m, CatalogId(0)));
        using var huge = await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(now, 1001m, CatalogId(0)));
        using var noExercise = await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(now, 55m));
        using var strayExercise = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now, 3m, CatalogId(0)));
        using var unknownKind = await app.PutGoalAsync(login, "weight", GoalBody(now, 70m));
        using var noClock = await app.SendAsync(
            HttpMethod.Put, "/api/v1/training/goals/weekly_sessions", new { value = 3m }, login.AccessToken, Guid.NewGuid());

        foreach (var response in new[] { zero, huge, noExercise, strayExercise, unknownKind, noClock })
        {
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        await using var db = app.Db();
        (await db.Set<Goal>().CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task UnknownExercise_AndAnotherUsersOwnExercise_Return422()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var foreignExercise = Guid.CreateVersion7();
        var otherUser = Guid.NewGuid();
        await using (var db = app.Db())
        {
            var now = DateTimeOffset.UtcNow;
            db.Exercises.Add(new UniOver.Modules.Training.Domain.Exercise
            {
                Id = foreignExercise, Slug = "alheio", Source = UniOver.Modules.Training.Contracts.ExerciseSources.Own, Name = "Alheio",
                OwnerUserId = otherUser, PrimaryMuscles = ["chest"], Equipment = "other", CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            });
            await db.SaveChangesAsync(Ct);
        }

        using var unknown = await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(DateTimeOffset.UtcNow, 55m, Guid.NewGuid()));
        using var foreign = await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(DateTimeOffset.UtcNow, 55m, foreignExercise));

        unknown.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(unknown)).Should().EndWith("exercise-not-found");
        foreign.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        await using var check = app.Db();
        (await check.Set<Goal>().CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task OwnExerciseThatWasDeleted_StillAcceptsTheGoal()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var exercise = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutCustomAsync(login, exercise, TrainingApp.CustomBody(now)))
        {
        }

        using (await app.PutCustomAsync(login, exercise, TrainingApp.CustomBody(now.AddMinutes(1), deleted: true)))
        {
        }

        using var response = await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(now.AddMinutes(2), 60m, exercise));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task ClockMoreThan24HoursAhead_Returns422_AndJustUnderIsAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var ahead = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(DateTimeOffset.UtcNow.AddHours(25)));
        using var edge = await app.PutGoalAsync(login, "daily_kcal", GoalBody(DateTimeOffset.UtcNow.AddHours(23), 2200m));

        ahead.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(ahead)).Should().EndWith("client-clock-ahead");
        edge.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task TwoUsers_NeverShareAGoal_EvenWithTheSameNaturalKey()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var foreign = NewGoal(Guid.NewGuid(), value: 6m);
        await using (var db = app.Db())
        {
            db.Add(foreign);
            await db.SaveChangesAsync(Ct);
        }

        using var response = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(DateTimeOffset.UtcNow.AddMinutes(5), 3m));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("id").GetGuid().Should().NotBe(foreign.Id);
        await using var check = app.Db();
        (await check.Set<Goal>().CountAsync(Ct)).Should().Be(2);
        (await check.Set<Goal>().SingleAsync(g => g.Id == foreign.Id, Ct)).Value.Should().Be(6m, "a meta de outra pessoa não é tocada");
    }

    [Fact]
    public async Task Commands_AreRateLimited_With429AndRetryAfter()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { CommandsPermitted = 3 });
        var login = await app.LoginAsync();

        var statuses = new List<HttpStatusCode>();
        HttpResponseMessage? limited = null;
        for (var i = 0; i < 6; i++)
        {
            var response = await app.PutGoalAsync(login, "weekly_sessions", GoalBody(DateTimeOffset.UtcNow.AddSeconds(i), 3m));
            statuses.Add(response.StatusCode);
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
            {
                limited = response;
                break;
            }

            response.Dispose();
        }

        statuses.Should().Contain(HttpStatusCode.TooManyRequests);
        statuses.Count(s => s == HttpStatusCode.OK).Should().Be(3);
        limited!.Headers.Contains("Retry-After").Should().BeTrue();
        (await TrainingAssertions.ProblemTypeAsync(limited)).Should().EndWith("rate-limited");
        limited.Dispose();
    }
}
