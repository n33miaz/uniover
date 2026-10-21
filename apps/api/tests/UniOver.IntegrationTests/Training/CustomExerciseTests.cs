using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;

namespace UniOver.IntegrationTests.Training;

[Collection(PostgresGroup.Name)]
public sealed class CustomExerciseTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PutCustomAsync(null, Guid.CreateVersion7(), TrainingApp.CustomBody(DateTimeOffset.UtcNow));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Put_CreatesTheOwnExercise_WithTheOwnersIdAndASlug()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();

        using var response = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(DateTimeOffset.UtcNow, "Supino do João"));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("id").GetGuid().Should().Be(id);
        body.GetProperty("source").GetString().Should().Be(ExerciseSources.Own);
        body.GetProperty("name").GetString().Should().Be("Supino do João");
        body.GetProperty("stepKg").GetDecimal().Should().Be(2.5m);
        await using var db = app.Db();
        var row = await db.Exercises.SingleAsync(e => e.Id == id, Ct);
        row.OwnerUserId.Should().Be(TrainingApp.UserIdOf(login));
        row.Slug.Should().StartWith("supino-do-joao-");
        row.SourceRef.Should().BeNull();
    }

    [Fact]
    public async Task NewIdThatIsNotV7_IsRefused_SoItCannotTakeAFutureCatalogId()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var futureCatalogId = ExerciseIds.ForCatalog(ExerciseSources.Wger, "uuid-que-ainda-nao-foi-importado");

        foreach (var id in new[] { futureCatalogId, Guid.NewGuid() })
        {
            using var response = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(DateTimeOffset.UtcNow, "Ocupando o catálogo"));

            response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            (await TrainingApp.JsonAsync(response)).GetProperty("errors").TryGetProperty("id", out _).Should().BeTrue();
            await using var db = app.Db();
            (await db.Exercises.AnyAsync(e => e.Id == id, Ct)).Should().BeFalse();
        }
    }

    [Fact]
    public async Task SameKey_SameBody_ReturnsTheStoredResponse_WithoutExecutingAgain()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var body = TrainingApp.CustomBody(DateTimeOffset.UtcNow);

        using var first = await app.PutCustomAsync(login, id, body, key);
        DateTimeOffset firstUpdatedAt;
        await using (var db = app.Db())
        {
            firstUpdatedAt = (await db.Exercises.SingleAsync(e => e.Id == id, Ct)).UpdatedAt;
        }

        using var second = await app.PutCustomAsync(login, id, body, key);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(first).Should().BeFalse();
        Replayed(second).Should().BeTrue();
        (await second.Content.ReadAsStringAsync(Ct)).Should().Be(await first.Content.ReadAsStringAsync(Ct));
        await using var check = app.Db();
        (await check.Exercises.SingleAsync(e => e.Id == id, Ct)).UpdatedAt.Should().Be(firstUpdatedAt);
    }

    [Fact]
    public async Task SameKey_DifferentBody_Returns422KeyReused()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        using (await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now), key))
        {
        }

        using var second = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now, "Outro nome"), key);

        second.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(second)).Should().EndWith("idempotency-key-reused");
    }

    [Fact]
    public async Task MissingIdempotencyKey_Returns400()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(
            HttpMethod.Put, $"/api/v1/training/exercises/{Guid.CreateVersion7()}", TrainingApp.CustomBody(DateTimeOffset.UtcNow), login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("idempotency-key-required");
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithTheSameKey_LeaveOneRow_AndNoServerError()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var body = TrainingApp.CustomBody(DateTimeOffset.UtcNow);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutCustomAsync(login, id, body, key)));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK || r.StatusCode == HttpStatusCode.Conflict);
        responses.Should().Contain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Exercises.CountAsync(e => e.Id == id, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithFiftyDifferentKeys_LeaveOneRow_AndAllSucceed()
    {
        // Sem a chave em comum, o que segura as duplicatas é a unicidade do id e o handler que relê depois de perder.
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var body = TrainingApp.CustomBody(DateTimeOffset.UtcNow);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutCustomAsync(login, id, body, Guid.NewGuid())));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK, "nenhum envio perde: quem perde a corrida relê e conclui");
        await using var db = app.Db();
        (await db.Exercises.CountAsync(e => e.Id == id, Ct)).Should().Be(1);
        (await db.Exercises.SingleAsync(e => e.Id == id, Ct)).Name.Should().Be("Meu supino");
    }

    [Fact]
    public async Task SimultaneousPutsWithDifferentClocks_EndWithTheNewestWrite()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var start = DateTimeOffset.UtcNow.AddMinutes(-10);

        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(i =>
            app.PutCustomAsync(login, id, TrainingApp.CustomBody(start.AddSeconds(i), $"Versão {i}"), Guid.NewGuid())));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Exercises.SingleAsync(e => e.Id == id, Ct)).Name.Should().Be("Versão 19", "vale o relógio mais novo, não a ordem de chegada");
    }

    [Fact]
    public async Task OlderWrite_IsIgnored_AndTheStoredRowComesBack()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now, "Novo")))
        {
        }

        using var older = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now.AddMinutes(-5), "Velho"));
        var body = await TrainingApp.JsonAsync(older);

        older.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("name").GetString().Should().Be("Novo");
        await using var db = app.Db();
        (await db.Exercises.SingleAsync(e => e.Id == id, Ct)).Name.Should().Be("Novo");
    }

    [Fact]
    public async Task NewerWrite_UpdatesTheRow_AndMovesTheServerClock()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now, "Antes")))
        {
        }

        DateTimeOffset before;
        await using (var db = app.Db())
        {
            before = (await db.Exercises.SingleAsync(e => e.Id == id, Ct)).UpdatedAt;
        }

        using var newer = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now.AddSeconds(30), "Depois"));

        newer.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = app.Db();
        var row = await check.Exercises.SingleAsync(e => e.Id == id, Ct);
        row.Name.Should().Be("Depois");
        row.UpdatedAt.Should().BeAfter(before);
    }

    [Fact]
    public async Task NewerTombstone_BeatsAnOlderEdit_AndAnOlderTombstoneDoesNotDelete()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now, "Vivo")))
        {
        }

        // Lápide mais velha que a edição guardada: ignorada.
        using (var older = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now.AddMinutes(-1), "Vivo", deleted: true)))
        {
            (await TrainingApp.JsonAsync(older)).GetProperty("deleted").GetBoolean().Should().BeFalse();
        }

        using (var newer = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now.AddMinutes(1), "Vivo", deleted: true)))
        {
            (await TrainingApp.JsonAsync(newer)).GetProperty("deleted").GetBoolean().Should().BeTrue();
        }

        // Edição mais velha que a lápide: não ressuscita.
        using (var edit = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now.AddSeconds(30), "Zumbi")))
        {
            (await TrainingApp.JsonAsync(edit)).GetProperty("deleted").GetBoolean().Should().BeTrue();
        }

        await using var db = app.Db();
        var row = await db.Exercises.SingleAsync(e => e.Id == id, Ct);
        row.DeletedAt.Should().NotBeNull();
        row.Name.Should().Be("Vivo");
    }

    [Fact]
    public async Task DeleteOfAnExerciseThatNeverArrived_StillLeavesATombstone()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        using (var tombstone = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now.AddMinutes(1), deleted: true)))
        {
            tombstone.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var late = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now));

        (await TrainingApp.JsonAsync(late)).GetProperty("deleted").GetBoolean().Should().BeTrue("a edição atrasada não ressuscita o registro");
    }

    [Fact]
    public async Task EditingACatalogRow_Returns403CatalogRowReadonly()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using (await app.PullAsync(login, limit: 1))
        {
        }

        var catalogId = ExerciseIds.ForCatalog(ExerciseSources.FreeExerciseDb, UniOver.Modules.Training.Catalog.CatalogSeedSource.Read().Exercises[0].SourceRef);

        using var response = await app.PutCustomAsync(login, catalogId, TrainingApp.CustomBody(DateTimeOffset.UtcNow));

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("catalog-row-readonly");
        await using var db = app.Db();
        (await db.Exercises.SingleAsync(e => e.Id == catalogId, Ct)).Name.Should().NotBe("Meu supino");
    }

    [Fact]
    public async Task EditingAnotherUsersExercise_Returns404_AndLeavesItUntouched()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        await using (var db = app.Db())
        {
            db.Exercises.Add(new Exercise
            {
                Id = id, Slug = "alheio", Source = ExerciseSources.Own, Name = "Alheio", OwnerUserId = Guid.NewGuid(),
                Equipment = Equipment.Other, PrimaryMuscles = [Muscle.Chest], CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            });
            await db.SaveChangesAsync(Ct);
        }

        using var response = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(now.AddMinutes(1), "Roubado"));

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        await using var check = app.Db();
        (await check.Exercises.SingleAsync(e => e.Id == id, Ct)).Name.Should().Be("Alheio");
    }

    [Fact]
    public async Task ClockMoreThan24HoursAhead_Returns422ClientClockAhead()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();

        using var response = await app.PutCustomAsync(login, id, TrainingApp.CustomBody(DateTimeOffset.UtcNow.AddHours(25)));

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("client-clock-ahead");
        await using var db = app.Db();
        (await db.Exercises.AnyAsync(e => e.Id == id, Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task ClockJustUnder24HoursAhead_IsAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutCustomAsync(login, Guid.CreateVersion7(), TrainingApp.CustomBody(DateTimeOffset.UtcNow.AddHours(23)));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("name", "")]
    [InlineData("equipment", "kettlebell")]
    [InlineData("recordType", "distance")]
    public async Task InvalidBody_Returns400WithTheFieldName(string field, string value)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = new Dictionary<string, object?>
        {
            ["name"] = "Meu supino",
            ["primaryMuscles"] = new[] { "chest" },
            ["secondaryMuscles"] = Array.Empty<string>(),
            ["equipment"] = "barbell",
            ["recordType"] = "weight_reps",
            ["clientUpdatedAt"] = DateTimeOffset.UtcNow,
            ["deleted"] = false,
            [field] = value,
        };

        using var response = await app.PutCustomAsync(login, Guid.CreateVersion7(), body);
        var problem = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        problem.GetProperty("errors").TryGetProperty(field, out _).Should().BeTrue();
    }

    [Fact]
    public async Task UnknownMuscle_Returns400()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = new
        {
            name = "Meu supino",
            primaryMuscles = new[] { "pinky_toe" },
            secondaryMuscles = Array.Empty<string>(),
            equipment = "barbell",
            recordType = "weight_reps",
            clientUpdatedAt = DateTimeOffset.UtcNow,
            deleted = false,
        };

        using var response = await app.PutCustomAsync(login, Guid.CreateVersion7(), body);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
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
            var response = await app.PutCustomAsync(login, Guid.CreateVersion7(), TrainingApp.CustomBody(DateTimeOffset.UtcNow));
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
    public async Task RuntimeRole_CanInsertIntoTheModule_ButNotCreateTables()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using (var put = await app.PutCustomAsync(login, Guid.CreateVersion7(), TrainingApp.CustomBody(DateTimeOffset.UtcNow)))
        {
            put.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await using var connection = new Npgsql.NpgsqlConnection(app.Database.RuntimeConnection);
        await connection.OpenAsync(Ct);
        await using var create = new Npgsql.NpgsqlCommand("CREATE TABLE training.intruder (id int)", connection);

        var act = () => create.ExecuteNonQueryAsync(Ct);

        (await act.Should().ThrowAsync<Npgsql.PostgresException>()).Which.SqlState.Should().Be("42501");
    }

    [Fact]
    public async Task ResponseJson_UsesCamelCase_AndNullableStepIsExplicit()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutCustomAsync(login, Guid.CreateVersion7(), TrainingApp.CustomBody(DateTimeOffset.UtcNow, stepKg: null));
        var body = await TrainingApp.JsonAsync(response);

        body.GetProperty("stepKg").ValueKind.Should().Be(JsonValueKind.Null);
        body.TryGetProperty("clientUpdatedAt", out _).Should().BeTrue();
        body.TryGetProperty("updatedAt", out _).Should().BeTrue();
    }
}
