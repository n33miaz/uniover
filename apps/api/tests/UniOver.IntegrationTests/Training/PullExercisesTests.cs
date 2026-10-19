using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;

namespace UniOver.IntegrationTests.Training;

[Collection(PostgresGroup.Name)]
public sealed class PullExercisesTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PullAsync(null);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task FirstPage_ComesWithTheCatalogAndACursor()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PullAsync(login, limit: 10);
        var page = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        page.GetProperty("items").GetArrayLength().Should().Be(10);
        page.GetProperty("nextCursor").GetString().Should().NotBeNullOrEmpty();
        var first = page.GetProperty("items")[0];
        first.GetProperty("source").GetString().Should().Be(ExerciseSources.FreeExerciseDb);
        first.GetProperty("license").GetString().Should().Be("Unlicense");
        first.GetProperty("deleted").GetBoolean().Should().BeFalse();
        first.GetProperty("primaryMuscles").GetArrayLength().Should().BeGreaterThan(0);
    }

    [Fact]
    public async Task Pages_NeverRepeatNorSkipARow_EvenWhenEveryRowHasTheSameUpdatedAt()
    {
        // A carga da semente grava todas as linhas no mesmo instante: o desempate pelo id é o que a leitura testa aqui.
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var total = CatalogSeedSource.Read().Exercises.Count;

        var pages = await app.PullAllPagesAsync(login, limit: 37);

        var ids = pages.SelectMany(p => p.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("id").GetGuid())).ToList();
        ids.Should().HaveCount(total);
        ids.Should().OnlyHaveUniqueItems();
        pages.Count.Should().BeGreaterThan(5);

        await using var db = app.Db();
        (await db.Exercises.Select(e => e.UpdatedAt).Distinct().CountAsync(Ct)).Should().Be(1, "o teste só vale se houver empate de updated_at");
    }

    [Fact]
    public async Task Pages_FollowTheDatabaseOrder_OfUpdatedAtThenId()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        var pages = await app.PullAllPagesAsync(login, limit: 50);
        var ids = pages.SelectMany(p => p.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("id").GetGuid())).ToList();

        await using var db = app.Db();
        var expected = await db.Exercises.AsNoTracking().OrderBy(e => e.UpdatedAt).ThenBy(e => e.Id).Select(e => e.Id).ToListAsync(Ct);
        ids.Should().Equal(expected);
    }

    [Fact]
    public async Task ReadingFromTheLastCursor_ReturnsNothingNew_UntilSomethingChanges()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var pages = await app.PullAllPagesAsync(login, limit: 500);
        var cursor = pages[0].GetProperty("nextCursor").GetString()!;

        using (var empty = await app.PullAsync(login, cursor, 500))
        {
            var body = await TrainingApp.JsonAsync(empty);
            body.GetProperty("items").GetArrayLength().Should().Be(0);
            body.GetProperty("nextCursor").GetString().Should().Be(cursor, "sem novidade o cursor fica onde estava");
        }

        var id = Guid.CreateVersion7();
        using (var put = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(DateTimeOffset.UtcNow)))
        {
            put.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var news = await app.PullAsync(login, cursor, 500);
        var changed = await TrainingApp.JsonAsync(news);
        changed.GetProperty("items").GetArrayLength().Should().Be(1);
        changed.GetProperty("items")[0].GetProperty("id").GetGuid().Should().Be(id);
        changed.GetProperty("items")[0].GetProperty("source").GetString().Should().Be(ExerciseSources.Own);
    }

    [Fact]
    public async Task OwnExercises_AreOnlyVisibleToTheirOwner()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var otherId = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        await using (var db = app.Db())
        {
            db.Exercises.Add(new Exercise
            {
                Id = otherId, Slug = "de-outra-pessoa", Source = ExerciseSources.Own, Name = "De outra pessoa", OwnerUserId = Guid.NewGuid(),
                Equipment = Equipment.Other, PrimaryMuscles = [Muscle.Chest], CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            });
            await db.SaveChangesAsync(Ct);
        }

        var pages = await app.PullAllPagesAsync(login, limit: 500);

        pages.SelectMany(p => p.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("id").GetGuid()))
            .Should().NotContain(otherId);
    }

    [Fact]
    public async Task Tombstones_AreDeliveredWithTheLiveRows()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now)))
        {
        }

        using (var delete = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now.AddSeconds(1), deleted: true)))
        {
            delete.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var pages = await app.PullAllPagesAsync(login, limit: 500);

        var item = pages.SelectMany(p => p.GetProperty("items").EnumerateArray()).Single(i => i.GetProperty("id").GetGuid() == id);
        item.GetProperty("deleted").GetBoolean().Should().BeTrue();
    }

    [Theory]
    [InlineData("limit=0")]
    [InlineData("limit=501")]
    [InlineData("after=lixo")]
    public async Task InvalidQuery_Returns400AsValidationProblem(string query)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/training/exercises?" + query, bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("validation-failed");
    }
}
