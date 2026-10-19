using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Sessions;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.Sessions;

[Collection(PostgresGroup.Name)]
public sealed class UpsertSetTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PutSetAsync(null, Guid.CreateVersion7(), Guid.CreateVersion7(), SetBody(DateTimeOffset.UtcNow, CatalogId(0)));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Put_CreatesTheSet_WithEveryField_AndTheOwnersId()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        using var response = await app.PutSetAsync(login, sessionId, id, SetBody(
            now, CatalogId(0), position: 3, setType: "failure", weightKg: 82.5m, reps: 6, rir: 1, rpe: 9.5m, note: "  quase  ", completedAt: now.AddSeconds(-4)));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("id").GetGuid().Should().Be(id);
        body.GetProperty("sessionId").GetGuid().Should().Be(sessionId);
        body.GetProperty("position").GetInt32().Should().Be(3);
        body.GetProperty("setType").GetString().Should().Be("failure");
        body.GetProperty("weightKg").GetDecimal().Should().Be(82.5m);
        body.GetProperty("reps").GetInt32().Should().Be(6);
        body.GetProperty("rir").GetInt32().Should().Be(1);
        body.GetProperty("rpe").GetDecimal().Should().Be(9.5m);
        body.GetProperty("note").GetString().Should().Be("quase");
        body.GetProperty("durationS").ValueKind.Should().Be(JsonValueKind.Null);
        body.GetProperty("deleted").GetBoolean().Should().BeFalse();
        await using var db = app.Db();
        (await db.Set<SessionSet>().SingleAsync(s => s.Id == id, Ct)).UserId.Should().Be(TrainingApp.UserIdOf(login));
    }

    [Fact]
    public async Task ASessionThatDoesNotExist_OrBelongsToAnotherUser_Returns404SessionNotFound()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var foreign = NewSession(Guid.NewGuid());
        await using (var db = app.Db())
        {
            db.Add(foreign);
            await db.SaveChangesAsync(Ct);
        }

        using var missing = await app.PutSetAsync(login, Guid.CreateVersion7(), Guid.CreateVersion7(), SetBody(DateTimeOffset.UtcNow, CatalogId(0)));
        using var other = await app.PutSetAsync(login, foreign.Id, Guid.CreateVersion7(), SetBody(DateTimeOffset.UtcNow, CatalogId(0)));

        missing.StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await TrainingAssertions.ProblemTypeAsync(missing)).Should().EndWith("session-not-found");
        other.StatusCode.Should().Be(HttpStatusCode.NotFound);
        await using var check = app.Db();
        (await check.Set<SessionSet>().AnyAsync(Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task UnknownExercise_AndAnotherUsersOwnExercise_Return422ExerciseNotFound()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var foreign = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        await using (var db = app.Db())
        {
            db.Exercises.Add(new Exercise
            {
                Id = foreign, Slug = "alheio", Source = ExerciseSources.Own, Name = "Alheio", OwnerUserId = Guid.NewGuid(),
                Equipment = Equipment.Other, PrimaryMuscles = [Muscle.Chest], CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            });
            await db.SaveChangesAsync(Ct);
        }

        using var unknown = await app.PutSetAsync(login, sessionId, Guid.CreateVersion7(), SetBody(now, Guid.NewGuid()));
        using var alien = await app.PutSetAsync(login, sessionId, Guid.CreateVersion7(), SetBody(now, foreign));

        unknown.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(unknown)).Should().EndWith("exercise-not-found");
        alien.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        await using var check = app.Db();
        (await check.Set<SessionSet>().AnyAsync(Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task AnOwnExercise_IsAccepted_EvenAfterItWasDeleted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var own = await app.CreateOwnExerciseAsync(login, ExerciseRecordTypes.RepsOnly);
        using (var delete = await app.PutCustomAsync(login, own, TrainingApp.CustomBody(DateTimeOffset.UtcNow.AddSeconds(5), deleted: true)))
        {
            delete.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var response = await app.PutSetAsync(login, sessionId, Guid.CreateVersion7(), SetBody(DateTimeOffset.UtcNow, own));

        response.StatusCode.Should().Be(HttpStatusCode.OK, "apagar um exercício num aparelho não pode fazer a série de outro falhar para sempre");
    }

    [Theory]
    [InlineData("weight_reps", "work", null, 8, null, false)]
    [InlineData("weight_reps", "work", 80, null, null, false)]
    [InlineData("weight_reps", "work", 80, 8, null, true)]
    [InlineData("weight_reps", "warmup", null, 12, null, true)]
    [InlineData("reps_only", "work", null, null, null, false)]
    [InlineData("reps_only", "work", null, 15, null, true)]
    [InlineData("time", "work", null, null, null, false)]
    [InlineData("time", "work", null, 10, null, false)]
    [InlineData("time", "work", null, null, 45, true)]
    public async Task TheShapeOfTheSet_FollowsTheRecordTypeOfTheExercise(string recordType, string setType, int? weight, int? reps, int? duration, bool accepted)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var exercise = await app.CreateOwnExerciseAsync(login, recordType);
        var id = Guid.CreateVersion7();

        using var response = await app.PutSetAsync(login, sessionId, id, SetBody(
            DateTimeOffset.UtcNow, exercise, setType: setType, weightKg: weight, reps: reps, durationS: duration));

        response.StatusCode.Should().Be(accepted ? HttpStatusCode.OK : HttpStatusCode.UnprocessableEntity);
        if (!accepted)
        {
            (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("set-shape-invalid");
        }

        await using var db = app.Db();
        (await db.Set<SessionSet>().AnyAsync(s => s.Id == id, Ct)).Should().Be(accepted);
    }

    [Fact]
    public async Task SameKey_SameBody_ReturnsTheStoredResponse_AndANewKeyLeavesTheRowUntouched()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var body = SetBody(DateTimeOffset.UtcNow, CatalogId(0));

        using var first = await app.PutSetAsync(login, sessionId, id, body, key);
        using var second = await app.PutSetAsync(login, sessionId, id, body, key);
        DateTimeOffset before;
        await using (var db = app.Db())
        {
            before = (await db.Set<SessionSet>().SingleAsync(s => s.Id == id, Ct)).UpdatedAt;
        }

        using var third = await app.PutSetAsync(login, sessionId, id, body);

        Replayed(first).Should().BeFalse();
        Replayed(second).Should().BeTrue();
        (await second.Content.ReadAsStringAsync(Ct)).Should().Be(await first.Content.ReadAsStringAsync(Ct));
        third.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = app.Db();
        (await check.Set<SessionSet>().CountAsync(s => s.Id == id, Ct)).Should().Be(1);
        (await check.Set<SessionSet>().SingleAsync(s => s.Id == id, Ct)).UpdatedAt.Should().Be(before);
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithTheSameKey_LeaveOneSet_AndNoServerError()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var body = SetBody(DateTimeOffset.UtcNow, CatalogId(0));

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutSetAsync(login, sessionId, id, body, key)));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK || r.StatusCode == HttpStatusCode.Conflict);
        responses.Should().Contain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Set<SessionSet>().CountAsync(s => s.Id == id, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithFiftyDifferentKeys_LeaveOneSet_AndAllSucceed()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var id = Guid.CreateVersion7();
        var body = SetBody(DateTimeOffset.UtcNow, CatalogId(0));

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutSetAsync(login, sessionId, id, body, Guid.NewGuid())));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Set<SessionSet>().CountAsync(s => s.Id == id, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task OlderPut_IsIgnored_AndANewerOneUpdatesTheSet()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutSetAsync(login, sessionId, id, SetBody(now, CatalogId(0), weightKg: 80m)))
        {
        }

        using var old = await app.PutSetAsync(login, sessionId, id, SetBody(now.AddMinutes(-5), CatalogId(0), weightKg: 60m));
        using var newer = await app.PutSetAsync(login, sessionId, id, SetBody(now.AddMinutes(1), CatalogId(0), weightKg: 85m, reps: 7));

        (await TrainingApp.JsonAsync(old)).GetProperty("weightKg").GetDecimal().Should().Be(80m);
        var body = await TrainingApp.JsonAsync(newer);
        body.GetProperty("weightKg").GetDecimal().Should().Be(85m);
        body.GetProperty("reps").GetInt32().Should().Be(7);
    }

    [Fact]
    public async Task NewerTombstone_BeatsAnOlderEdit_AndAnOlderTombstoneDoesNotDelete()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var now = DateTimeOffset.UtcNow;
        var dead = Guid.CreateVersion7();
        var alive = Guid.CreateVersion7();
        using (await app.PutSetAsync(login, sessionId, dead, SetBody(now, CatalogId(0))))
        {
        }

        using (await app.PutSetAsync(login, sessionId, alive, SetBody(now.AddMinutes(2), CatalogId(0))))
        {
        }

        using (await app.PutSetAsync(login, sessionId, dead, SetBody(now.AddMinutes(1), CatalogId(0), deleted: true)))
        {
        }

        using var lateEdit = await app.PutSetAsync(login, sessionId, dead, SetBody(now.AddSeconds(30), CatalogId(0), weightKg: 99m));
        using var lateTombstone = await app.PutSetAsync(login, sessionId, alive, SetBody(now.AddMinutes(1), CatalogId(0), deleted: true));

        (await TrainingApp.JsonAsync(lateEdit)).GetProperty("deleted").GetBoolean().Should().BeTrue();
        (await TrainingApp.JsonAsync(lateTombstone)).GetProperty("deleted").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task ASetOfADeletedSession_IsStoredAsATombstone_AndNeverComesBackToLife()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var sessionId = await app.OpenSessionAsync(login, now.AddMinutes(-10));
        using (await app.PutSessionAsync(login, sessionId, SessionBody(now.AddMinutes(-5), deleted: true)))
        {
        }

        var id = Guid.CreateVersion7();
        using var response = await app.PutSetAsync(login, sessionId, id, SetBody(now, CatalogId(0)));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK, "o pedido que ainda estava na fila não pode falhar para sempre");
        body.GetProperty("deleted").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task ARefusalThatDependsOnServerState_IsReplayedForTheSameKey_ButNotForANewOne()
    {
        // Confirma o contrato da fila: o servidor guarda a resposta 4xx por chave. Por isso "tentar de novo" o mesmo item da
        // fila não adianta depois que o motivo da recusa passou; só um pedido novo (outra chave) chega.
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = Guid.CreateVersion7();
        var setId = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var body = SetBody(DateTimeOffset.UtcNow, CatalogId(0));

        using (var first = await app.PutSetAsync(login, sessionId, setId, body, key))
        {
            first.StatusCode.Should().Be(HttpStatusCode.NotFound);
        }

        using (var open = await app.PutSessionAsync(login, sessionId, SessionBody(DateTimeOffset.UtcNow.AddSeconds(-1))))
        {
            open.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var replayed = await app.PutSetAsync(login, sessionId, setId, body, key);
        using var fresh = await app.PutSetAsync(login, sessionId, setId, body);

        replayed.StatusCode.Should().Be(HttpStatusCode.NotFound);
        Replayed(replayed).Should().BeTrue();
        fresh.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task ASetIdThatBelongsToAnotherUser_OrToAnotherSession_Returns404()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var user = TrainingApp.UserIdOf(login);
        var sessionId = await app.OpenSessionAsync(login);
        var foreignSession = NewSession(Guid.NewGuid());
        var foreignSet = NewSet(foreignSession.UserId, foreignSession.Id, CatalogId(0));
        var otherOwnSession = NewSession(user, finishedAt: DateTimeOffset.UtcNow.AddMinutes(-5));
        var ownSet = NewSet(user, otherOwnSession.Id, CatalogId(0));
        using (var seeding = await app.PutSetAsync(login, sessionId, Guid.CreateVersion7(), SetBody(DateTimeOffset.UtcNow, CatalogId(0))))
        {
            seeding.StatusCode.Should().Be(HttpStatusCode.OK); // a primeira série carrega a semente do catálogo
        }

        await using (var db = app.Db())
        {
            db.AddRange(foreignSession, otherOwnSession);
            await db.SaveChangesAsync(Ct);
            db.AddRange(foreignSet, ownSet);
            await db.SaveChangesAsync(Ct);
        }

        using var stolen = await app.PutSetAsync(login, sessionId, foreignSet.Id, SetBody(DateTimeOffset.UtcNow.AddMinutes(1), CatalogId(0)));
        using var moved = await app.PutSetAsync(login, sessionId, ownSet.Id, SetBody(DateTimeOffset.UtcNow.AddMinutes(1), CatalogId(0)));

        stolen.StatusCode.Should().Be(HttpStatusCode.NotFound);
        moved.StatusCode.Should().Be(HttpStatusCode.NotFound);
        await using var check = app.Db();
        (await check.Set<SessionSet>().SingleAsync(s => s.Id == ownSet.Id, Ct)).SessionId.Should().Be(otherOwnSession.Id);
    }

    [Fact]
    public async Task ATwoHundredSetQueue_SentInOrder_LosesAndDuplicatesNothing()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow.AddMinutes(-90);
        var sessionId = Guid.CreateVersion7();
        using (var open = await app.PutSessionAsync(login, sessionId, SessionBody(now, startedAt: now)))
        {
            open.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var ids = new List<Guid>();
        for (var i = 0; i < 200; i++)
        {
            var id = Guid.CreateVersion7();
            ids.Add(id);
            using var response = await app.PutSetAsync(login, sessionId, id, SetBody(
                now.AddSeconds(i + 1), CatalogId(i % 5), position: i, weightKg: 20m + i, reps: 5 + (i % 8)));
            response.StatusCode.Should().Be(HttpStatusCode.OK, $"a série {i}");

            // Um reenvio no meio do caminho (resposta perdida): o mesmo pedido de novo não pode duplicar nem mexer.
            if (i % 25 == 0)
            {
                using var resend = await app.PutSetAsync(login, sessionId, id, SetBody(
                    now.AddSeconds(i + 1), CatalogId(i % 5), position: i, weightKg: 20m + i, reps: 5 + (i % 8)));
                resend.StatusCode.Should().Be(HttpStatusCode.OK);
            }
        }

        using (var finish = await app.PutSessionAsync(login, sessionId, SessionBody(now.AddSeconds(300), startedAt: now, finishedAt: now.AddSeconds(300), feeling: 5)))
        {
            finish.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var pulled = (await app.PullAllAsync(login, "sets", limit: 60)).Rows().ToList();
        pulled.Select(r => r.GetProperty("id").GetGuid()).Should().Equal(ids, "nenhuma série se perde nem se repete, e a ordem é a da gravação");
        pulled.Select(r => r.GetProperty("position").GetInt32()).Should().Equal(Enumerable.Range(0, 200));
        await using var db = app.Db();
        (await db.Set<SessionSet>().CountAsync(s => s.SessionId == sessionId, Ct)).Should().Be(200);
    }

    [Fact]
    public async Task ClockMoreThan24HoursAhead_Returns422()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);

        using var response = await app.PutSetAsync(login, sessionId, Guid.CreateVersion7(), SetBody(DateTimeOffset.UtcNow.AddHours(25), CatalogId(0)));

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("client-clock-ahead");
    }

    [Theory]
    [InlineData("setType", "pyramid")]
    [InlineData("weightKg", -5)]
    [InlineData("reps", 1000)]
    [InlineData("rir", 11)]
    [InlineData("rpe", 7.25)]
    [InlineData("durationS", 90000)]
    public async Task OutOfLimits_Returns400WithTheFieldName(string field, object value)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);
        var body = new Dictionary<string, object?>
        {
            ["exerciseId"] = CatalogId(0),
            ["position"] = 0,
            ["setType"] = "work",
            ["weightKg"] = 80,
            ["reps"] = 8,
            ["completedAt"] = DateTimeOffset.UtcNow,
            ["clientUpdatedAt"] = DateTimeOffset.UtcNow,
            ["deleted"] = false,
            [field] = value,
        };

        using var response = await app.PutSetAsync(login, sessionId, Guid.CreateVersion7(), body);
        var problem = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        problem.GetProperty("errors").TryGetProperty(field, out _).Should().BeTrue();
    }

    [Fact]
    public async Task Commands_AreRateLimited_With429AndRetryAfter()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { CommandsPermitted = 4 });
        var login = await app.LoginAsync();
        var sessionId = await app.OpenSessionAsync(login);

        HttpResponseMessage? limited = null;
        for (var i = 0; i < 8; i++)
        {
            var response = await app.PutSetAsync(login, sessionId, Guid.CreateVersion7(), SetBody(DateTimeOffset.UtcNow, CatalogId(0)));
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
            {
                limited = response;
                break;
            }

            response.Dispose();
        }

        limited.Should().NotBeNull();
        limited!.Headers.Contains("Retry-After").Should().BeTrue();
        (await TrainingAssertions.ProblemTypeAsync(limited)).Should().EndWith("rate-limited");
        limited.Dispose();
    }
}
