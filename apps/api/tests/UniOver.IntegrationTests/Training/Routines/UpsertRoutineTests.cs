using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using static UniOver.IntegrationTests.Training.Routines.RoutineHelpers;

namespace UniOver.IntegrationTests.Training.Routines;

[Collection(PostgresGroup.Name)]
public sealed class UpsertRoutineTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    private static async Task<List<RoutineItem>> ItemsOfAsync(TrainingApp app, Guid routineId)
    {
        await using var db = app.Db();
        return await db.Set<RoutineItem>().AsNoTracking().Where(i => i.RoutineId == routineId).OrderBy(i => i.Position).ToListAsync(Ct);
    }

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PutRoutineAsync(null, Guid.CreateVersion7(), Body(DateTimeOffset.UtcNow));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Put_CreatesTheRoutine_WithTheItemsInOrder_AndTheOwnersId()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var squat = CatalogId(0);
        var bench = CatalogId(1);

        using var response = await app.PutRoutineAsync(login, id, Body(
            DateTimeOffset.UtcNow,
            [Item(Guid.CreateVersion7(), squat, 0, sets: 4, repMin: 6, repMax: 10, rest: 120, note: "carga alta"), Item(Guid.CreateVersion7(), bench, 1)],
            name: "  A · Peito  ", position: 2, note: "  foco  "));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("id").GetGuid().Should().Be(id);
        body.GetProperty("name").GetString().Should().Be("A · Peito");
        body.GetProperty("position").GetInt32().Should().Be(2);
        body.GetProperty("active").GetBoolean().Should().BeTrue();
        body.GetProperty("note").GetString().Should().Be("foco");
        body.GetProperty("deleted").GetBoolean().Should().BeFalse();
        var items = body.GetProperty("items").EnumerateArray().ToList();
        items.Select(i => i.GetProperty("exerciseId").GetGuid()).Should().Equal(squat, bench);
        items[0].GetProperty("targetSets").GetInt32().Should().Be(4);
        items[0].GetProperty("repMin").GetInt32().Should().Be(6);
        items[0].GetProperty("repMax").GetInt32().Should().Be(10);
        items[0].GetProperty("restSeconds").GetInt32().Should().Be(120);
        items[0].GetProperty("note").GetString().Should().Be("carga alta");
        items[0].GetProperty("supersetGroup").ValueKind.Should().Be(JsonValueKind.Null);

        await using var db = app.Db();
        var row = await db.Set<Routine>().SingleAsync(r => r.Id == id, Ct);
        row.UserId.Should().Be(TrainingApp.UserIdOf(login));
        row.DeletedAt.Should().BeNull();
        (await ItemsOfAsync(app, id)).Should().HaveCount(2);
    }

    [Fact]
    public async Task Put_RecompactsThePositions_ByTheOrderTheDeviceSent()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var (a, b, c) = (Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7());

        using var response = await app.PutRoutineAsync(login, id, Body(
            DateTimeOffset.UtcNow, [Item(a, CatalogId(0), 30), Item(b, CatalogId(1), 5), Item(c, CatalogId(2), 17)]));
        var items = (await TrainingApp.JsonAsync(response)).GetProperty("items").EnumerateArray().ToList();

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        items.Select(i => i.GetProperty("id").GetGuid()).Should().Equal(b, c, a);
        items.Select(i => i.GetProperty("position").GetInt32()).Should().Equal(0, 1, 2);
        (await ItemsOfAsync(app, id)).Select(i => (i.Id, i.Position)).Should().Equal((b, 0), (c, 1), (a, 2));
    }

    [Fact]
    public async Task AnEmptyRoutine_IsValid()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(DateTimeOffset.UtcNow, items: []));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TrainingApp.JsonAsync(response)).GetProperty("items").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task SameKey_SameBody_ReturnsTheStoredResponse_WithoutExecutingAgain_AndDoesNotDuplicateItems()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var body = Body(DateTimeOffset.UtcNow, [Item(Guid.CreateVersion7(), CatalogId(0), 0), Item(Guid.CreateVersion7(), CatalogId(1), 1)]);

        using var first = await app.PutRoutineAsync(login, id, body, key);
        using var second = await app.PutRoutineAsync(login, id, body, key);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(first).Should().BeFalse();
        Replayed(second).Should().BeTrue();
        (await second.Content.ReadAsStringAsync(Ct)).Should().Be(await first.Content.ReadAsStringAsync(Ct));
        (await ItemsOfAsync(app, id)).Should().HaveCount(2);
    }

    [Fact]
    public async Task TheSameBodyWithANewKey_IsStillIdempotent_AndLeavesTheRowUntouched()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var body = Body(DateTimeOffset.UtcNow, [Item(Guid.CreateVersion7(), CatalogId(0), 0)]);
        using (await app.PutRoutineAsync(login, id, body))
        {
        }

        DateTimeOffset before;
        await using (var db = app.Db())
        {
            before = (await db.Set<Routine>().SingleAsync(r => r.Id == id, Ct)).UpdatedAt;
        }

        using var again = await app.PutRoutineAsync(login, id, body);

        again.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(again).Should().BeFalse("a chave é outra: o handler é quem garante a idempotência pelo id");
        await using var check = app.Db();
        (await check.Set<Routine>().SingleAsync(r => r.Id == id, Ct)).UpdatedAt.Should().Be(before);
        (await ItemsOfAsync(app, id)).Should().HaveCount(1);
    }

    [Fact]
    public async Task SameKey_DifferentBody_Returns422KeyReused()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutRoutineAsync(login, id, Body(now), key))
        {
        }

        using var second = await app.PutRoutineAsync(login, id, Body(now, name: "Outro nome"), key);

        second.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(second)).Should().EndWith("idempotency-key-reused");
    }

    [Fact]
    public async Task MissingIdempotencyKey_Returns400()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(
            HttpMethod.Put, $"/api/v1/training/routines/{Guid.CreateVersion7()}", Body(DateTimeOffset.UtcNow), login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("idempotency-key-required");
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithTheSameKey_LeaveOneRoutine_AndNoServerError()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var body = Body(DateTimeOffset.UtcNow, [Item(Guid.CreateVersion7(), CatalogId(0), 0), Item(Guid.CreateVersion7(), CatalogId(1), 1), Item(Guid.CreateVersion7(), CatalogId(2), 2)]);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutRoutineAsync(login, id, body, key)));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK || r.StatusCode == HttpStatusCode.Conflict);
        responses.Should().Contain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Set<Routine>().CountAsync(r => r.Id == id, Ct)).Should().Be(1);
        (await ItemsOfAsync(app, id)).Should().HaveCount(3, "o envio repetido nunca duplica item");
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithFiftyDifferentKeys_LeaveOneRoutine_AndAllSucceed()
    {
        // Sem a chave em comum, o que segura as duplicatas é a unicidade do id e o handler que relê depois de perder.
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var body = Body(DateTimeOffset.UtcNow, [Item(Guid.CreateVersion7(), CatalogId(0), 0), Item(Guid.CreateVersion7(), CatalogId(1), 1)]);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutRoutineAsync(login, id, body, Guid.NewGuid())));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK, "nenhum envio perde: quem perde a corrida relê e conclui");
        await using var db = app.Db();
        (await db.Set<Routine>().CountAsync(r => r.Id == id, Ct)).Should().Be(1);
        (await ItemsOfAsync(app, id)).Should().HaveCount(2);
    }

    [Fact]
    public async Task SimultaneousPutsWithDifferentClocks_EndWithTheNewestWrite_AndItsItems()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var start = DateTimeOffset.UtcNow.AddMinutes(-10);

        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(i =>
            app.PutRoutineAsync(login, id, Body(start.AddSeconds(i), [Item(Guid.CreateVersion7(), CatalogId(i), 0)], name: $"Versão {i}"), Guid.NewGuid())));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Set<Routine>().SingleAsync(r => r.Id == id, Ct)).Name.Should().Be("Versão 19", "vale o relógio mais novo, não a ordem de chegada");
        var items = await ItemsOfAsync(app, id);
        items.Should().ContainSingle().Which.ExerciseId.Should().Be(CatalogId(19), "os itens vêm da mesma escrita do cabeçalho");
    }

    [Fact]
    public async Task Edit_SwapsTheItemsTogether_KeepingTheOnesWithTheSameId_AndDroppingWhatLeft()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var (a, b, c, d) = (Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7());
        var now = DateTimeOffset.UtcNow;
        using (await app.PutRoutineAsync(login, id, Body(now, [Item(a, CatalogId(0), 0), Item(b, CatalogId(1), 1), Item(c, CatalogId(2), 2)])))
        {
        }

        using var edit = await app.PutRoutineAsync(login, id, Body(
            now.AddSeconds(10), [Item(d, CatalogId(3), 0, sets: 5), Item(b, CatalogId(1), 1, sets: 4, rest: 60)], name: "A editada"));
        var body = await TrainingApp.JsonAsync(edit);

        edit.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("name").GetString().Should().Be("A editada");
        body.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("id").GetGuid()).Should().Equal(d, b);
        var items = await ItemsOfAsync(app, id);
        items.Select(i => i.Id).Should().Equal(d, b);
        items.Should().NotContain(i => i.Id == a || i.Id == c, "item que sumiu do corpo some do banco");
        items[1].TargetSets.Should().Be(4);
        items[1].RestSeconds.Should().Be(60);
        await using var db = app.Db();
        (await db.Set<RoutineItem>().CountAsync(Ct)).Should().Be(2);
    }

    [Fact]
    public async Task Edit_CanReplaceEveryItemWithNewIds_AndMoveAnExerciseToAnotherPosition()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var (a, b) = (Guid.CreateVersion7(), Guid.CreateVersion7());
        var now = DateTimeOffset.UtcNow;
        using (await app.PutRoutineAsync(login, id, Body(now, [Item(a, CatalogId(0), 0), Item(b, CatalogId(1), 1)])))
        {
        }

        using var swap = await app.PutRoutineAsync(login, id, Body(now.AddSeconds(5), [Item(b, CatalogId(1), 0), Item(a, CatalogId(0), 1)]));
        swap.StatusCode.Should().Be(HttpStatusCode.OK);
        (await ItemsOfAsync(app, id)).Select(i => i.Id).Should().Equal(b, a);

        var fresh = new[] { Guid.CreateVersion7(), Guid.CreateVersion7() };
        using var replace = await app.PutRoutineAsync(login, id, Body(now.AddSeconds(10), [Item(fresh[0], CatalogId(4), 0), Item(fresh[1], CatalogId(5), 1)]));
        replace.StatusCode.Should().Be(HttpStatusCode.OK);
        (await ItemsOfAsync(app, id)).Select(i => i.Id).Should().Equal(fresh);
    }

    [Fact]
    public async Task OlderPut_IsIgnored_AndTheStoredRoutineComesBack()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var item = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutRoutineAsync(login, id, Body(now, [Item(item, CatalogId(0), 0)], name: "Novo")))
        {
        }

        using var older = await app.PutRoutineAsync(login, id, Body(now.AddMinutes(-5), [Item(Guid.CreateVersion7(), CatalogId(1), 0)], name: "Velho"));
        var body = await TrainingApp.JsonAsync(older);

        older.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("name").GetString().Should().Be("Novo");
        body.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("id").GetGuid()).Should().Equal(item);
        (await ItemsOfAsync(app, id)).Should().ContainSingle().Which.Id.Should().Be(item);
    }

    [Fact]
    public async Task NewerWrite_UpdatesTheRoutine_AndMovesTheServerClock()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutRoutineAsync(login, id, Body(now, name: "Antes")))
        {
        }

        DateTimeOffset before;
        await using (var db = app.Db())
        {
            before = (await db.Set<Routine>().SingleAsync(r => r.Id == id, Ct)).UpdatedAt;
        }

        using var newer = await app.PutRoutineAsync(login, id, Body(now.AddSeconds(30), name: "Depois", active: false));

        newer.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = app.Db();
        var row = await check.Set<Routine>().SingleAsync(r => r.Id == id, Ct);
        row.Name.Should().Be("Depois");
        row.Active.Should().BeFalse();
        row.UpdatedAt.Should().BeAfter(before);
    }

    [Fact]
    public async Task NewerTombstone_BeatsAnOlderEdit_AndAnOlderTombstoneDoesNotDelete()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var item = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutRoutineAsync(login, id, Body(now, [Item(item, CatalogId(0), 0)], name: "Viva")))
        {
        }

        // Lápide mais velha que a edição guardada: ignorada.
        using (var older = await app.PutRoutineAsync(login, id, Body(now.AddMinutes(-1), name: "Viva", deleted: true)))
        {
            (await TrainingApp.JsonAsync(older)).GetProperty("deleted").GetBoolean().Should().BeFalse();
        }

        using (var newer = await app.PutRoutineAsync(login, id, Body(now.AddMinutes(1), name: "Viva", deleted: true)))
        {
            (await TrainingApp.JsonAsync(newer)).GetProperty("deleted").GetBoolean().Should().BeTrue();
        }

        // Edição mais velha que a lápide: não ressuscita.
        using (var edit = await app.PutRoutineAsync(login, id, Body(now.AddSeconds(30), [Item(Guid.CreateVersion7(), CatalogId(1), 0)], name: "Zumbi")))
        {
            (await TrainingApp.JsonAsync(edit)).GetProperty("deleted").GetBoolean().Should().BeTrue();
        }

        await using var db = app.Db();
        var row = await db.Set<Routine>().SingleAsync(r => r.Id == id, Ct);
        row.DeletedAt.Should().NotBeNull();
        row.Name.Should().Be("Viva");
        (await ItemsOfAsync(app, id)).Should().ContainSingle().Which.Id.Should().Be(item, "a lápide não mexe nos itens e a edição velha foi ignorada");
    }

    [Fact]
    public async Task ANewerEdit_ResurrectsATombstonedRoutine()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutRoutineAsync(login, id, Body(now, name: "Vai e volta", deleted: true)))
        {
        }

        using var back = await app.PutRoutineAsync(login, id, Body(now.AddMinutes(1), [Item(Guid.CreateVersion7(), CatalogId(0), 0)], name: "Voltou"));
        var body = await TrainingApp.JsonAsync(back);

        body.GetProperty("deleted").GetBoolean().Should().BeFalse();
        body.GetProperty("items").GetArrayLength().Should().Be(1);
        await using var db = app.Db();
        (await db.Set<Routine>().SingleAsync(r => r.Id == id, Ct)).DeletedAt.Should().BeNull();
    }

    [Fact]
    public async Task DeleteOfARoutineThatNeverArrived_StillLeavesATombstone()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        using (var tombstone = await app.PutRoutineAsync(login, id, Body(now.AddMinutes(1), deleted: true)))
        {
            tombstone.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var late = await app.PutRoutineAsync(login, id, Body(now));

        (await TrainingApp.JsonAsync(late)).GetProperty("deleted").GetBoolean().Should().BeTrue("a edição atrasada não ressuscita o registro");
        (await ItemsOfAsync(app, id)).Should().BeEmpty();
    }

    [Fact]
    public async Task UnknownExercise_Returns422ExerciseNotFound_AndCreatesNothing()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();

        using var response = await app.PutRoutineAsync(login, id, Body(
            DateTimeOffset.UtcNow, [Item(Guid.CreateVersion7(), CatalogId(0), 0), Item(Guid.CreateVersion7(), Guid.NewGuid(), 1)]));

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("exercise-not-found");
        await using var db = app.Db();
        (await db.Set<Routine>().AnyAsync(r => r.Id == id, Ct)).Should().BeFalse();
        (await db.Set<RoutineItem>().AnyAsync(Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task AnotherUsersOwnExercise_CountsAsNotFound()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var foreign = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        await using (var db = app.Db())
        {
            db.Exercises.Add(new Exercise
            {
                Id = foreign, Slug = "alheio", Source = "own", Name = "Alheio", OwnerUserId = Guid.NewGuid(),
                Equipment = Equipment.Other, PrimaryMuscles = [Muscle.Chest], CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            });
            await db.SaveChangesAsync(Ct);
        }

        using var response = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(now, [Item(Guid.CreateVersion7(), foreign, 0)]));

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("exercise-not-found");
    }

    [Fact]
    public async Task OwnExercise_IsAccepted_EvenAfterItWasDeleted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var own = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (var create = await app.PutCustomAsync(login, own, TrainingApp.CustomBody(now)))
        {
            create.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using (var routine = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(now, [Item(Guid.CreateVersion7(), own, 0)])))
        {
            routine.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using (var delete = await app.PutCustomAsync(login, own, TrainingApp.CustomBody(now.AddSeconds(5), deleted: true)))
        {
            delete.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var late = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(now.AddSeconds(6), [Item(Guid.CreateVersion7(), own, 0)]));

        late.StatusCode.Should().Be(HttpStatusCode.OK, "apagar um exercício num aparelho não pode falhar para sempre o pedido de outro");
    }

    [Fact]
    public async Task Supersets_OutOfOrder_Return422SupersetNotContiguous_AndCreateNothing()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();

        using var response = await app.PutRoutineAsync(login, id, Body(
            DateTimeOffset.UtcNow,
            [
                Item(Guid.CreateVersion7(), CatalogId(0), 0, superset: 1),
                Item(Guid.CreateVersion7(), CatalogId(1), 1),
                Item(Guid.CreateVersion7(), CatalogId(2), 2, superset: 1),
            ]));

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("superset-not-contiguous");
        await using var db = app.Db();
        (await db.Set<Routine>().AnyAsync(r => r.Id == id, Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task Supersets_AreJudgedByPosition_NotByTheOrderOfTheArray()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var (a, b, c) = (Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7());

        using var response = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(
            DateTimeOffset.UtcNow, [Item(a, CatalogId(0), 1, superset: 1), Item(b, CatalogId(1), 0), Item(c, CatalogId(2), 2, superset: 1)]));
        var items = (await TrainingApp.JsonAsync(response)).GetProperty("items").EnumerateArray().ToList();

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        items.Select(i => i.GetProperty("id").GetGuid()).Should().Equal(b, a, c);
        items.Select(i => i.GetProperty("supersetGroup").ValueKind).Should().Equal(JsonValueKind.Null, JsonValueKind.Number, JsonValueKind.Number);
    }

    [Fact]
    public async Task ALoneSupersetGroup_IsStoredAsNoGroup()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();

        using var response = await app.PutRoutineAsync(login, id, Body(
            DateTimeOffset.UtcNow, [Item(Guid.CreateVersion7(), CatalogId(0), 0, superset: 3), Item(Guid.CreateVersion7(), CatalogId(1), 1)]));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await ItemsOfAsync(app, id)).Should().OnlyContain(i => i.SupersetGroup == null);
    }

    [Fact]
    public async Task AnotherUsersRoutine_Returns404_AndStaysUntouched()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        await using (var db = app.Db())
        {
            db.Set<Routine>().Add(new Routine
            {
                Id = id, UserId = Guid.NewGuid(), Name = "Alheia", Position = 0, Active = true,
                CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            });
            await db.SaveChangesAsync(Ct);
        }

        using var response = await app.PutRoutineAsync(login, id, Body(now.AddMinutes(1), name: "Roubada"));

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        await using var check = app.Db();
        (await check.Set<Routine>().SingleAsync(r => r.Id == id, Ct)).Name.Should().Be("Alheia");
        (await check.Set<RoutineItem>().AnyAsync(Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task ClockMoreThan24HoursAhead_Returns422ClientClockAhead()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();

        using var response = await app.PutRoutineAsync(login, id, Body(DateTimeOffset.UtcNow.AddHours(25)));

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("client-clock-ahead");
        await using var db = app.Db();
        (await db.Set<Routine>().AnyAsync(r => r.Id == id, Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task ClockJustUnder24HoursAhead_IsAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(DateTimeOffset.UtcNow.AddHours(23)));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task FortyItems_AreAccepted_AndFortyOneAreRefusedWith400()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        object[] Items(int count) => [.. Enumerable.Range(0, count).Select(i => Item(Guid.CreateVersion7(), CatalogId(i % 40), i))];

        using var forty = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(now, Items(40)));
        using var tooMany = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(now, Items(41)));

        forty.StatusCode.Should().Be(HttpStatusCode.OK);
        tooMany.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await TrainingApp.JsonAsync(tooMany)).GetProperty("errors").TryGetProperty("items", out _).Should().BeTrue();
    }

    [Fact]
    public async Task TheSameItemIdInTwoRoutines_NeverCollides()
    {
        // O id do item só é único dentro da rotina: o de outra rotina (ou de outra pessoa) não colide nem revela nada.
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var shared = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        using var first = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(now, [Item(shared, CatalogId(0), 0)]));
        using var second = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(now, [Item(shared, CatalogId(0), 0)]));

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("name")]
    [InlineData("position")]
    [InlineData("active")]
    [InlineData("items")]
    [InlineData("clientUpdatedAt")]
    public async Task MissingField_Returns400WithTheFieldName(string field)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = new Dictionary<string, object?>
        {
            ["name"] = "A",
            ["position"] = 0,
            ["active"] = true,
            ["items"] = Array.Empty<object>(),
            ["clientUpdatedAt"] = DateTimeOffset.UtcNow,
            ["deleted"] = false,
        };
        body.Remove(field);

        using var response = await app.PutRoutineAsync(login, Guid.CreateVersion7(), body);
        var problem = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        problem.GetProperty("errors").TryGetProperty(field, out _).Should().BeTrue();
    }

    [Theory]
    [InlineData(0, 8, 12, 90)]
    [InlineData(21, 8, 12, 90)]
    [InlineData(3, 12, 8, 90)]
    [InlineData(3, 0, 12, 90)]
    [InlineData(3, 8, 101, 90)]
    [InlineData(3, 8, 12, 1801)]
    [InlineData(3, 8, 12, -1)]
    public async Task ItemOutOfLimits_Returns400(int sets, int repMin, int repMax, int rest)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(
            DateTimeOffset.UtcNow, [Item(Guid.CreateVersion7(), CatalogId(0), 0, sets, repMin, repMax, rest)]));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await TrainingApp.JsonAsync(response)).GetProperty("errors").TryGetProperty("items[0]", out _).Should().BeTrue();
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
            var response = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(DateTimeOffset.UtcNow));
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

    [Fact]
    public async Task ResponseJson_UsesCamelCase_AndNullsAreExplicit()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutRoutineAsync(login, Guid.CreateVersion7(), Body(DateTimeOffset.UtcNow, note: null));
        var body = await TrainingApp.JsonAsync(response);

        body.GetProperty("note").ValueKind.Should().Be(JsonValueKind.Null);
        body.TryGetProperty("clientUpdatedAt", out _).Should().BeTrue();
        body.TryGetProperty("updatedAt", out _).Should().BeTrue();
        body.GetProperty("items")[0].TryGetProperty("exerciseId", out _).Should().BeTrue();
    }
}
