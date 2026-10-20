using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain.Goals;
using static UniOver.IntegrationTests.Training.Goals.GoalHelpers;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.Goals;

[Collection(PostgresGroup.Name)]
public sealed class PullGoalsTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PullGoalsAsync(null);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task WithNoGoal_ReturnsAnEmptyPage_AndNoCursor()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PullGoalsAsync(login);
        var page = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        page.GetProperty("items").GetArrayLength().Should().Be(0);
        page.GetProperty("nextCursor").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task Pages_NeverRepeatNorSkip_EvenWithTheSameUpdatedAt_AndTombstonesComeToo()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var userId = TrainingApp.UserIdOf(login);
        var sameInstant = DateTimeOffset.UtcNow.AddMinutes(-3);
        var goals = new List<Goal>
        {
            NewGoal(userId, GoalKinds.WeeklySessions, updatedAt: sameInstant),
            NewGoal(userId, GoalKinds.DailyKcal, value: 2200m, updatedAt: sameInstant),
            NewGoal(userId, GoalKinds.ExerciseE1rm, CatalogId(0), 55m, sameInstant),
        };
        await using (var seed = app.Db())
        {
            // O catálogo é carregado de forma preguiçosa; uma meta de 1RM já o carrega pelo PUT.
            using (await app.PutGoalAsync(login, "exercise_e1rm", GoalBody(DateTimeOffset.UtcNow, 70m, CatalogId(1))))
            {
            }

            goals.Add(NewGoal(userId, GoalKinds.ExerciseE1rm, CatalogId(2), deleted: true, updatedAt: sameInstant));
            seed.AddRange(goals);
            await seed.SaveChangesAsync(Ct);
        }

        var pulled = (await app.PullAllGoalsAsync(login, limit: 2)).Rows().ToList();

        pulled.Should().HaveCount(5);
        pulled.Select(r => r.GetProperty("id").GetGuid()).Should().OnlyHaveUniqueItems();
        pulled.Take(4).Select(r => r.GetProperty("id").GetGuid()).Should().Equal(goals.Select(g => g.Id).Order());
        var tombstone = pulled.Single(r => r.GetProperty("deleted").GetBoolean());
        tombstone.GetProperty("value").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task ThePullComesBackInTheOrderOfTheServerClock_SoALaterWriteIsSeenAgain()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now, 3m)))
        {
        }

        string? cursor;
        using (var first = await app.PullGoalsAsync(login))
        {
            cursor = (await TrainingApp.JsonAsync(first)).GetProperty("nextCursor").GetString();
        }

        using (await app.PutGoalAsync(login, "weekly_sessions", GoalBody(now.AddMinutes(1), 4m)))
        {
        }

        using var second = await app.PullGoalsAsync(login, cursor);
        var items = (await TrainingApp.JsonAsync(second)).GetProperty("items");

        items.GetArrayLength().Should().Be(1);
        items[0].GetProperty("value").GetDecimal().Should().Be(4m);
    }

    [Fact]
    public async Task TwoUsers_NeverSeeEachOthersGoals()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using (await app.PutGoalAsync(login, "weekly_sessions", GoalBody(DateTimeOffset.UtcNow, 3m)))
        {
        }

        var foreign = NewGoal(Guid.NewGuid(), GoalKinds.DailyKcal, value: 2500m);
        await using (var db = app.Db())
        {
            db.Add(foreign);
            await db.SaveChangesAsync(Ct);
        }

        var pulled = (await app.PullAllGoalsAsync(login, limit: 50)).Rows().Select(r => r.GetProperty("kind").GetString()).ToList();

        pulled.Should().Equal("weekly_sessions");
    }

    [Theory]
    [InlineData("não é cursor", null)]
    [InlineData(null, 0)]
    [InlineData(null, 501)]
    public async Task InvalidCursorOrLimit_Returns400(string? after, int? limit)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PullGoalsAsync(login, after, limit);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
