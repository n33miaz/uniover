using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Features.Routines.ListRoutineTemplates;
using static UniOver.IntegrationTests.Training.Routines.RoutineHelpers;

namespace UniOver.IntegrationTests.Training.Routines;

[Collection(PostgresGroup.Name)]
public sealed class PullRoutinesTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task CreateAsync(TrainingApp app, LoggedIn login, Guid id, string name, DateTimeOffset at, bool deleted = false)
    {
        using var response = await app.PutRoutineAsync(login, id, Body(at, [Item(Guid.CreateVersion7(), CatalogId(0), 0), Item(Guid.CreateVersion7(), CatalogId(1), 1)], name: name, deleted: deleted));
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PullRoutinesAsync(null);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task WithNoRoutine_ReturnsAnEmptyPage_AndNoCursor()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PullRoutinesAsync(login);
        var page = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        page.GetProperty("items").GetArrayLength().Should().Be(0);
        page.GetProperty("nextCursor").ValueKind.Should().Be(System.Text.Json.JsonValueKind.Null);
    }

    [Fact]
    public async Task Pages_NeverRepeatNorSkip_AndComeWithTheItems_TombstonesIncluded()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var ids = Enumerable.Range(0, 7).Select(_ => Guid.CreateVersion7()).ToList();
        for (var i = 0; i < ids.Count; i++)
        {
            await CreateAsync(app, login, ids[i], $"Rotina {i}", now.AddSeconds(i), deleted: i == 3);
        }

        var pages = await app.PullAllRoutinePagesAsync(login, limit: 2);

        pages.Count.Should().BeGreaterThanOrEqualTo(4);
        var routines = pages.Routines().ToList();
        routines.Select(r => r.GetProperty("id").GetGuid()).Should().Equal(ids, "a ordem é a do instante de gravação no servidor");
        routines.Single(r => r.GetProperty("id").GetGuid() == ids[3]).GetProperty("deleted").GetBoolean().Should().BeTrue();
        routines.Where(r => !r.GetProperty("deleted").GetBoolean()).Should().OnlyContain(r => r.GetProperty("items").GetArrayLength() == 2);
    }

    [Fact]
    public async Task Pages_NeverRepeatNorSkip_EvenWhenEveryRoutineHasTheSameUpdatedAt()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var user = TrainingApp.UserIdOf(login);
        var stamp = DateTimeOffset.UtcNow.AddMinutes(-5);
        var ids = Enumerable.Range(0, 9).Select(_ => Guid.CreateVersion7()).ToList();
        await using (var db = app.Db())
        {
            db.Set<Routine>().AddRange(ids.Select((id, i) => new Routine
            {
                Id = id, UserId = user, Name = $"Rotina {i}", Position = i, Active = true,
                CreatedAt = stamp, UpdatedAt = stamp, ClientUpdatedAt = stamp,
            }));
            await db.SaveChangesAsync(Ct);
        }

        var pages = await app.PullAllRoutinePagesAsync(login, limit: 2);

        var pulled = pages.Routines().Select(r => r.GetProperty("id").GetGuid()).ToList();
        pulled.Should().HaveCount(9).And.OnlyHaveUniqueItems();
        pulled.Should().Equal(ids.Order(), "o empate de updated_at é desempatado pelo id");
    }

    [Fact]
    public async Task ReadingFromTheLastCursor_ReturnsNothingNew_UntilSomethingChanges()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        await CreateAsync(app, login, Guid.CreateVersion7(), "Primeira", now);
        var pages = await app.PullAllRoutinePagesAsync(login, limit: 500);
        var cursor = pages[0].GetProperty("nextCursor").GetString()!;

        using (var empty = await app.PullRoutinesAsync(login, cursor, 500))
        {
            var body = await TrainingApp.JsonAsync(empty);
            body.GetProperty("items").GetArrayLength().Should().Be(0);
            body.GetProperty("nextCursor").GetString().Should().Be(cursor, "sem novidade o cursor fica onde estava");
        }

        var changed = Guid.CreateVersion7();
        await CreateAsync(app, login, changed, "Nova", now.AddSeconds(1));

        using var news = await app.PullRoutinesAsync(login, cursor, 500);
        var items = (await TrainingApp.JsonAsync(news)).GetProperty("items").EnumerateArray().ToList();
        items.Should().ContainSingle().Which.GetProperty("id").GetGuid().Should().Be(changed);
    }

    [Fact]
    public async Task EditingARoutine_MakesItReturnInTheIncrementalRead()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var id = Guid.CreateVersion7();
        await CreateAsync(app, login, id, "Antes", now);
        var cursor = (await app.PullAllRoutinePagesAsync(login, 500))[0].GetProperty("nextCursor").GetString()!;

        await CreateAsync(app, login, id, "Depois", now.AddSeconds(5));

        using var news = await app.PullRoutinesAsync(login, cursor, 500);
        var item = (await TrainingApp.JsonAsync(news)).GetProperty("items").EnumerateArray().Single();
        item.GetProperty("name").GetString().Should().Be("Depois");
    }

    [Fact]
    public async Task TwoUsers_NeverSeeEachOthersRoutines()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var foreign = Guid.CreateVersion7();
        var mine = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        // A leitura do catálogo faz a carga da semente, de onde vem o exercício do item da rotina alheia.
        using (var seed = await app.PullAsync(login, limit: 1))
        {
            seed.EnsureSuccessStatusCode();
        }

        await using (var db = app.Db())
        {
            var other = new Routine
            {
                Id = foreign, UserId = Guid.NewGuid(), Name = "Alheia", Position = 0, Active = true,
                CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            };
            other.Items.Add(new RoutineItem
            {
                RoutineId = foreign, Id = Guid.CreateVersion7(), ExerciseId = CatalogId(0), Position = 0,
                TargetSets = 3, RepMin = 8, RepMax = 12, RestSeconds = 90,
            });
            db.Set<Routine>().Add(other);
            await db.SaveChangesAsync(Ct);
        }

        await CreateAsync(app, login, mine, "Minha", now);

        var pages = await app.PullAllRoutinePagesAsync(login, limit: 50);

        pages.Routines().Select(r => r.GetProperty("id").GetGuid()).Should().Equal(mine);
    }

    [Fact]
    public async Task InvalidQuery_Returns400AsValidationProblem()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        foreach (var query in new[] { "limit=0", "limit=501", "after=lixo" })
        {
            using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/training/routines?" + query, bearer: login.AccessToken);

            response.StatusCode.Should().Be(HttpStatusCode.BadRequest, query);
            (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("validation-failed");
        }
    }

    [Fact]
    public async Task Templates_ComeFromTheEmbeddedFile_WithoutLogin401_AndWithoutTouchingTheCatalog()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var anonymous = await app.SendAsync(HttpMethod.Get, "/api/v1/training/routine-templates");
        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/training/routine-templates", bearer: login.AccessToken);
        var body = await TrainingApp.JsonAsync(response);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var templates = body.GetProperty("items").EnumerateArray().ToList();
        templates.Select(t => t.GetProperty("id").GetString()).Should().Equal(
            "abc", "abcd", "full-body",
            "ppl-superior-inferior", "superior-inferior-acessorios", "divisao-familiar-reforco-inferior",
            "ab-reajustado", "full-body-cardio", "historical-ab");
        templates.Select(t => t.GetProperty("routines").GetArrayLength()).Should().Equal(3, 4, 2, 5, 5, 5, 2, 3, 2);
        var first = templates[0].GetProperty("routines")[0];
        first.GetProperty("name").GetString().Should().NotBeNullOrWhiteSpace();
        var item = first.GetProperty("items")[0];
        item.GetProperty("exerciseSlug").GetString().Should().NotBeNullOrWhiteSpace();
        item.TryGetProperty("targetSets", out _).Should().BeTrue();
        item.TryGetProperty("repMin", out _).Should().BeTrue();
        item.TryGetProperty("repMax", out _).Should().BeTrue();
        item.TryGetProperty("restSeconds", out _).Should().BeTrue();

        var cardioPlan = templates.Single(t => t.GetProperty("id").GetString() == "full-body-cardio");
        cardioPlan.GetProperty("description").GetString().Should().Contain("15–25 min");
        cardioPlan.GetProperty("description").GetString().Should().Contain("20–40 s");

        var historicalPlan = templates.Single(t => t.GetProperty("id").GetString() == "historical-ab");
        historicalPlan.GetProperty("name").GetString().Should().Contain("histórico");
        historicalPlan.GetProperty("description").GetString().Should().Contain("nunca será ativado automaticamente");

        // Sem banco: ler os modelos não carrega a semente do catálogo.
        await using var db = app.Db();
        (await db.Exercises.AnyAsync(Ct)).Should().BeFalse("os modelos não dependem do banco");
        RoutineTemplateSource.Read().Items.Should().HaveCount(9);
    }
}
