using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain.Sessions;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.Sessions;

[Collection(PostgresGroup.Name)]
public sealed class UpsertSessionTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PutSessionAsync(null, Guid.CreateVersion7(), SessionBody(DateTimeOffset.UtcNow));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Put_CreatesTheSession_WithTheOwnersIdAndTheDevice()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        using var response = await app.PutSessionAsync(login, id, SessionBody(now, startedAt: now.AddMinutes(-30), note: "  ok  ", deviceId: "  aparelho-a  "));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("id").GetGuid().Should().Be(id);
        body.GetProperty("deviceId").GetString().Should().Be("aparelho-a");
        body.GetProperty("note").GetString().Should().Be("ok");
        body.GetProperty("finishedAt").ValueKind.Should().Be(JsonValueKind.Null);
        body.GetProperty("routineId").ValueKind.Should().Be(JsonValueKind.Null);
        body.GetProperty("deleted").GetBoolean().Should().BeFalse();
        await using var db = app.Db();
        var row = await db.Set<Session>().SingleAsync(s => s.Id == id, Ct);
        row.UserId.Should().Be(TrainingApp.UserIdOf(login));
        row.IsOpen.Should().BeTrue();
    }

    [Fact]
    public async Task SameKey_SameBody_ReturnsTheStoredResponse_WithoutExecutingAgain()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var body = SessionBody(DateTimeOffset.UtcNow);

        using var first = await app.PutSessionAsync(login, id, body, key);
        using var second = await app.PutSessionAsync(login, id, body, key);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(first).Should().BeFalse();
        Replayed(second).Should().BeTrue();
        (await second.Content.ReadAsStringAsync(Ct)).Should().Be(await first.Content.ReadAsStringAsync(Ct));
        await using var db = app.Db();
        (await db.Set<Session>().CountAsync(s => s.Id == id, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task TheSameBodyWithANewKey_IsStillIdempotent_AndLeavesTheRowUntouched()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var body = SessionBody(DateTimeOffset.UtcNow);
        using (await app.PutSessionAsync(login, id, body))
        {
        }

        DateTimeOffset before;
        await using (var db = app.Db())
        {
            before = (await db.Set<Session>().SingleAsync(s => s.Id == id, Ct)).UpdatedAt;
        }

        using var again = await app.PutSessionAsync(login, id, body);

        again.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = app.Db();
        (await check.Set<Session>().SingleAsync(s => s.Id == id, Ct)).UpdatedAt.Should().Be(before);
    }

    [Fact]
    public async Task SameKey_DifferentBody_Returns422KeyReused_AndMissingKeyRunsWithoutReplay()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutSessionAsync(login, id, SessionBody(now), key))
        {
        }

        using var reused = await app.PutSessionAsync(login, id, SessionBody(now, note: "outra"), key);
        using var missing = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/sessions/{id}", SessionBody(now), login.AccessToken);

        reused.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(reused)).Should().EndWith("idempotency-key-reused");
        missing.StatusCode.Should().Be(HttpStatusCode.OK, "sem chave a escrita segue sem proteção, nesta transição");
        missing.Headers.Contains("Idempotent-Replayed").Should().BeFalse();
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithTheSameKey_LeaveOneSession_AndNoServerError()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var key = Guid.NewGuid();
        var body = SessionBody(DateTimeOffset.UtcNow);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutSessionAsync(login, id, body, key)));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK || r.StatusCode == HttpStatusCode.Conflict);
        responses.Should().Contain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Set<Session>().CountAsync(s => s.Id == id, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithFiftyDifferentKeys_LeaveOneSession_AndAllSucceed()
    {
        // Sem a chave em comum, o que segura as duplicatas é a unicidade do id e o handler que relê depois de perder.
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var body = SessionBody(DateTimeOffset.UtcNow);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutSessionAsync(login, id, body, Guid.NewGuid())));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK, "nenhum envio perde: quem perde a corrida relê e conclui");
        await using var db = app.Db();
        (await db.Set<Session>().CountAsync(s => s.Id == id, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task OlderPut_IsIgnored_AndTheStoredSessionComesBack()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutSessionAsync(login, id, SessionBody(now, note: "nova")))
        {
        }

        using var old = await app.PutSessionAsync(login, id, SessionBody(now.AddMinutes(-5), note: "velha"));
        var body = await TrainingApp.JsonAsync(old);

        old.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("note").GetString().Should().Be("nova");
    }

    [Fact]
    public async Task NewerWrite_FinishesTheSession_AndMovesTheServerClock()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutSessionAsync(login, id, SessionBody(now.AddMinutes(-40), startedAt: now.AddMinutes(-45))))
        {
        }

        DateTimeOffset before;
        await using (var db = app.Db())
        {
            before = (await db.Set<Session>().SingleAsync(s => s.Id == id, Ct)).UpdatedAt;
        }

        using var finish = await app.PutSessionAsync(login, id, SessionBody(now, startedAt: now.AddMinutes(-45), finishedAt: now, feeling: 4, note: "pesado"));
        var body = await TrainingApp.JsonAsync(finish);

        finish.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("feeling").GetInt32().Should().Be(4);
        body.GetProperty("finishedAt").ValueKind.Should().Be(JsonValueKind.String);
        await using var check = app.Db();
        var row = await check.Set<Session>().SingleAsync(s => s.Id == id, Ct);
        row.IsOpen.Should().BeFalse();
        row.UpdatedAt.Should().BeAfter(before);
    }

    [Fact]
    public async Task NewerTombstone_BeatsAnOlderEdit_AndAnOlderTombstoneDoesNotDelete()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var dead = await app.OpenSessionAsync(login, now);
        using (await app.PutSessionAsync(login, dead, SessionBody(now.AddMinutes(1), deleted: true)))
        {
        }

        using var lateEdit = await app.PutSessionAsync(login, dead, SessionBody(now.AddSeconds(30), note: "atrasada"));

        (await TrainingApp.JsonAsync(lateEdit)).GetProperty("deleted").GetBoolean().Should().BeTrue("a edição atrasada não ressuscita o registro");

        var alive = await app.OpenSessionAsync(login, now.AddMinutes(2));
        using var lateTombstone = await app.PutSessionAsync(login, alive, SessionBody(now.AddMinutes(1), deleted: true));

        (await TrainingApp.JsonAsync(lateTombstone)).GetProperty("deleted").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task ATombstoneOfASessionThatNeverArrived_StillLeavesATombstone()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();

        using var response = await app.PutSessionAsync(login, id, SessionBody(DateTimeOffset.UtcNow, deleted: true));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Set<Session>().SingleAsync(s => s.Id == id, Ct)).IsDeleted.Should().BeTrue();
    }

    [Fact]
    public async Task Tombstone_AlsoDeletesTheSets_WithANewServerClock_SoThePullPropagatesIt()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var sessionId = await app.OpenSessionAsync(login, now.AddMinutes(-30));
        var setIds = new List<Guid>();
        for (var i = 0; i < 3; i++)
        {
            var setId = Guid.CreateVersion7();
            setIds.Add(setId);
            using var set = await app.PutSetAsync(login, sessionId, setId, SetBody(now.AddMinutes(-20 + i), CatalogId(0), position: i));
            set.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        string cursorBefore;
        using (var pull = await app.PullResourceAsync(login, "sets"))
        {
            cursorBefore = (await TrainingApp.JsonAsync(pull)).GetProperty("nextCursor").GetString()!;
        }

        using var tombstone = await app.PutSessionAsync(login, sessionId, SessionBody(now, startedAt: now.AddMinutes(-30), deleted: true));
        tombstone.StatusCode.Should().Be(HttpStatusCode.OK);

        using var after = await app.PullResourceAsync(login, "sets", cursorBefore);
        var rows = (await TrainingApp.JsonAsync(after)).GetProperty("items").EnumerateArray().ToList();
        rows.Should().HaveCount(3, "as séries do treino apagado voltam na leitura incremental, já como lápide");
        rows.Should().OnlyContain(r => r.GetProperty("deleted").GetBoolean());
        rows.Select(r => r.GetProperty("id").GetGuid()).Should().BeEquivalentTo(setIds);
        await using var db = app.Db();
        (await db.Set<SessionSet>().Where(s => s.SessionId == sessionId).ToListAsync(Ct)).Should().OnlyContain(s => s.DeletedAt != null);
    }

    [Fact]
    public async Task UnknownRoutine_Returns422RoutineNotFound_AndCreatesNothing()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();

        using var response = await app.PutSessionAsync(login, id, SessionBody(DateTimeOffset.UtcNow, routineId: Guid.NewGuid()));

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("routine-not-found");
        await using var db = app.Db();
        (await db.Set<Session>().AnyAsync(s => s.Id == id, Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task AnotherUsersRoutine_CountsAsNotFound_ButADeletedOwnRoutineIsAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var user = TrainingApp.UserIdOf(login);
        var foreign = NewRoutine(Guid.NewGuid());
        var mine = NewRoutine(user, deleted: true);
        await using (var db = app.Db())
        {
            db.AddRange(foreign, mine);
            await db.SaveChangesAsync(Ct);
        }

        using var refused = await app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(DateTimeOffset.UtcNow, routineId: foreign.Id, finishedAt: DateTimeOffset.UtcNow));
        using var accepted = await app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(DateTimeOffset.UtcNow, routineId: mine.Id));

        refused.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        accepted.StatusCode.Should().Be(HttpStatusCode.OK, "apagar a rotina num aparelho não pode fazer o treino de outro falhar para sempre");
    }

    [Fact]
    public async Task FinishBeforeStart_Returns422_AndCreatesNothing()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        using var response = await app.PutSessionAsync(login, id, SessionBody(now, startedAt: now, finishedAt: now.AddMinutes(-1)));

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("session-finish-before-start");
        await using var db = app.Db();
        (await db.Set<Session>().AnyAsync(s => s.Id == id, Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task ASecondOpenSession_OnAnotherDevice_IsBlocked_AndTheAnswerSaysWhichOneIsOpen()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var first = await app.OpenSessionAsync(login, DateTimeOffset.UtcNow.AddMinutes(-20), deviceId: "celular");
        var second = Guid.CreateVersion7();

        using var response = await app.PutSessionAsync(login, second, SessionBody(DateTimeOffset.UtcNow, deviceId: "tablet"));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        body.GetProperty("type").GetString().Should().EndWith("session-already-open");
        body.GetProperty("sessionId").GetGuid().Should().Be(first);
        body.GetProperty("deviceId").GetString().Should().Be("celular");
        body.TryGetProperty("startedAt", out _).Should().BeTrue();
        await using var db = app.Db();
        (await db.Set<Session>().AnyAsync(s => s.Id == second, Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task ASecondOpenSession_OnTheSameDevice_IsBlockedToo()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        await app.OpenSessionAsync(login, DateTimeOffset.UtcNow.AddMinutes(-20));

        using var response = await app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(DateTimeOffset.UtcNow));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task TheOwnerDevice_CanKeepEditingItsOpenSession()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var id = await app.OpenSessionAsync(login, now.AddMinutes(-20));

        using var edit = await app.PutSessionAsync(login, id, SessionBody(now, startedAt: T0, note: "anotação durante o treino"));

        edit.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AfterTheFirstIsFinished_OrDeleted_ANewSessionCanOpen()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var first = await app.OpenSessionAsync(login, now.AddMinutes(-60), deviceId: "celular");
        using (var finish = await app.PutSessionAsync(login, first, SessionBody(now.AddMinutes(-30), startedAt: T0, finishedAt: now.AddMinutes(-30), deviceId: "celular")))
        {
            finish.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var second = Guid.CreateVersion7();
        using (var open = await app.PutSessionAsync(login, second, SessionBody(now.AddMinutes(-20), deviceId: "tablet")))
        {
            open.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using (var blocked = await app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(now.AddMinutes(-10), deviceId: "celular")))
        {
            blocked.StatusCode.Should().Be(HttpStatusCode.Conflict);
        }

        using (var discard = await app.PutSessionAsync(login, second, SessionBody(now.AddMinutes(-5), deviceId: "tablet", deleted: true)))
        {
            discard.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var third = await app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(now, deviceId: "celular"));
        third.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task ReopeningAFinishedSession_IsBlockedWhileAnotherIsOpen()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var first = await app.OpenSessionAsync(login, now.AddMinutes(-60));
        using (await app.PutSessionAsync(login, first, SessionBody(now.AddMinutes(-50), startedAt: T0, finishedAt: now.AddMinutes(-50))))
        {
        }

        await app.OpenSessionAsync(login, now.AddMinutes(-40), deviceId: "tablet");

        using var reopen = await app.PutSessionAsync(login, first, SessionBody(now, startedAt: T0));

        reopen.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task TwentySimultaneousOpens_OfDifferentSessions_LeaveExactlyOneOpen()
    {
        // O que segura a corrida é o índice único parcial do banco; quem perde relê e recebe 409 com a sessão que ganhou.
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(i =>
            app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(DateTimeOffset.UtcNow, deviceId: $"aparelho-{i}"))));

        responses.Count(r => r.StatusCode == HttpStatusCode.OK).Should().Be(1);
        responses.Count(r => r.StatusCode == HttpStatusCode.Conflict).Should().Be(19);
        await using var db = app.Db();
        (await db.Set<Session>().CountAsync(s => s.FinishedAt == null && s.DeletedAt == null, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task AnotherUsersOpenSession_DoesNotBlock_AndAnotherUsersSession_Returns404()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var foreign = NewSession(Guid.NewGuid());
        await using (var db = app.Db())
        {
            db.Add(foreign);
            await db.SaveChangesAsync(Ct);
        }

        using var mine = await app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(DateTimeOffset.UtcNow));
        using var steal = await app.PutSessionAsync(login, foreign.Id, SessionBody(DateTimeOffset.UtcNow.AddMinutes(1), note: "roubada"));

        mine.StatusCode.Should().Be(HttpStatusCode.OK);
        steal.StatusCode.Should().Be(HttpStatusCode.NotFound);
        await using var check = app.Db();
        (await check.Set<Session>().SingleAsync(s => s.Id == foreign.Id, Ct)).Note.Should().BeNull();
    }

    [Fact]
    public async Task ClockMoreThan24HoursAhead_Returns422_AndJustUnderIsAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var ahead = await app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(DateTimeOffset.UtcNow.AddHours(25)));
        using var edge = await app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(DateTimeOffset.UtcNow.AddHours(23)));

        ahead.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(ahead)).Should().EndWith("client-clock-ahead");
        edge.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("startedAt")]
    [InlineData("deviceId")]
    [InlineData("clientUpdatedAt")]
    public async Task MissingField_Returns400WithTheFieldName(string field)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = new Dictionary<string, object?>
        {
            ["startedAt"] = DateTimeOffset.UtcNow,
            ["deviceId"] = "aparelho-a",
            ["clientUpdatedAt"] = DateTimeOffset.UtcNow,
            ["deleted"] = false,
        };
        body.Remove(field);

        using var response = await app.PutSessionAsync(login, Guid.CreateVersion7(), body);
        var problem = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        problem.GetProperty("errors").TryGetProperty(field, out _).Should().BeTrue();
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(6, 1)]
    [InlineData(3, 65)]
    public async Task OutOfLimits_Returns400(int feeling, int deviceLength)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutSessionAsync(
            login, Guid.CreateVersion7(), SessionBody(DateTimeOffset.UtcNow, feeling: feeling, deviceId: new string('d', deviceLength)));

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
            var now = DateTimeOffset.UtcNow;
            var response = await app.PutSessionAsync(login, Guid.CreateVersion7(), SessionBody(now, finishedAt: now));
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
