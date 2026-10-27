using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Body;
using static UniOver.IntegrationTests.Training.BodyMetrics.BodyHelpers;

namespace UniOver.IntegrationTests.Training.BodyMetrics;

[Collection(PostgresGroup.Name)]
public sealed class UpsertBodyEntryTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PutEntryAsync(null, Guid.CreateVersion7(), EntryBody(DateTimeOffset.UtcNow));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Put_CreatesTheEntryWithTheClientsId_TheOwnersUser_AndEveryValueIntact()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var stamp = DateTimeOffset.UtcNow;

        using var response = await app.PutEntryAsync(
            login, id,
            EntryBody(stamp, measuredOn: Today(), weightKg: 82.45m, bodyFatPct: 16.9m, fatMethod: "navy", waistCm: 86m, neckCm: 38m, hipCm: 99.5m, armCm: 35.2m, thighCm: 58m, note: "  de manhã  "));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("id").GetGuid().Should().Be(id);
        body.GetProperty("measuredOn").GetString().Should().Be(Today());
        body.GetProperty("weightKg").GetDecimal().Should().Be(82.45m);
        body.GetProperty("bodyFatPct").GetDecimal().Should().Be(16.9m);
        body.GetProperty("fatMethod").GetString().Should().Be("navy");
        body.GetProperty("waistCm").GetDecimal().Should().Be(86m);
        body.GetProperty("hipCm").GetDecimal().Should().Be(99.5m);
        body.GetProperty("note").GetString().Should().Be("de manhã", "o texto é aparado");
        body.GetProperty("deleted").GetBoolean().Should().BeFalse();
        await using var db = app.Db();
        var row = await db.Set<BodyEntry>().SingleAsync(e => e.Id == id, Ct);
        row.UserId.Should().Be(TrainingApp.UserIdOf(login));
        row.ThighCm.Should().Be(58m);
        row.ClientUpdatedAt.Should().Be(TimeStamps.ToStorage(stamp));
    }

    [Fact]
    public async Task EachValueAloneIsEnough_ButTheNoteAloneIsNot()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        var onlyOne = new (string Label, object Body)[]
        {
            ("peso", EntryBody(now, weightKg: 80m)),
            ("gordura", EntryBody(now, weightKg: null, bodyFatPct: 15m, fatMethod: "manual")),
            ("cintura", EntryBody(now, weightKg: null, waistCm: 80m)),
            ("pescoço", EntryBody(now, weightKg: null, neckCm: 38m)),
            ("quadril", EntryBody(now, weightKg: null, hipCm: 99m)),
            ("braço", EntryBody(now, weightKg: null, armCm: 35m)),
            ("coxa", EntryBody(now, weightKg: null, thighCm: 58m)),
        };
        foreach (var (label, body) in onlyOne)
        {
            using var response = await app.PutEntryAsync(login, Guid.CreateVersion7(), body);
            response.StatusCode.Should().Be(HttpStatusCode.OK, label);
        }

        using var empty = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, weightKg: null, note: "só uma anotação"));

        empty.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(empty)).Should().EndWith("body-entry-empty");
        await using var db = app.Db();
        (await db.Set<BodyEntry>().CountAsync(Ct)).Should().Be(7, "a medição vazia não deixa linha");
    }

    [Fact]
    public async Task SameKey_SameBody_ReturnsTheStoredResponse_WithoutExecutingAgain()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();
        var id = Guid.CreateVersion7();
        var body = EntryBody(DateTimeOffset.UtcNow);

        using var first = await app.PutEntryAsync(login, id, body, key);
        using var second = await app.PutEntryAsync(login, id, body, key);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(first).Should().BeFalse();
        Replayed(second).Should().BeTrue();
        (await second.Content.ReadAsStringAsync(Ct)).Should().Be(await first.Content.ReadAsStringAsync(Ct));
        await using var db = app.Db();
        (await db.Set<BodyEntry>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task TheSameBodyWithANewKey_IsStillIdempotent_AndLeavesTheRowUntouched()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var body = EntryBody(DateTimeOffset.UtcNow);
        using (await app.PutEntryAsync(login, id, body))
        {
        }

        BodyEntry before;
        await using (var db = app.Db())
        {
            before = await db.Set<BodyEntry>().SingleAsync(Ct);
        }

        using var again = await app.PutEntryAsync(login, id, body);

        again.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = app.Db();
        var after = await check.Set<BodyEntry>().SingleAsync(Ct);
        after.UpdatedAt.Should().Be(before.UpdatedAt, "o reenvio idêntico não regrava");
    }

    [Fact]
    public async Task SameKey_DifferentBody_Returns422KeyReused_AndMissingKeyRunsWithoutReplay()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutEntryAsync(login, id, EntryBody(now, weightKg: 80m), key))
        {
        }

        using var reused = await app.PutEntryAsync(login, id, EntryBody(now, weightKg: 81m), key);
        using var missing = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/body/entries/{id}", EntryBody(now), login.AccessToken);

        reused.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(reused)).Should().EndWith("idempotency-key-reused");
        missing.StatusCode.Should().Be(HttpStatusCode.OK, "sem chave a escrita segue sem proteção, nesta transição");
        missing.Headers.Contains("Idempotent-Replayed").Should().BeFalse();
    }

    [Fact]
    public async Task FiftySimultaneousPuts_OfTheSameId_WithTheSameKey_LeaveOneRow_AndNoServerError()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();
        var id = Guid.CreateVersion7();
        var body = EntryBody(DateTimeOffset.UtcNow);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutEntryAsync(login, id, body, key)));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK || r.StatusCode == HttpStatusCode.Conflict);
        responses.Should().Contain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Set<BodyEntry>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task FiftySimultaneousPuts_OfTheSameId_WithFiftyDifferentKeys_LeaveOneRow_AndAllSucceed()
    {
        // Sem a chave em comum, o que segura as duplicatas é a chave primária e o handler que relê.
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var body = EntryBody(DateTimeOffset.UtcNow);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutEntryAsync(login, id, body, Guid.NewGuid())));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK, "nenhum envio perde: quem perde a corrida relê e conclui");
        await using var db = app.Db();
        (await db.Set<BodyEntry>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task FiftySimultaneousPuts_OfTheSameId_WithDifferentValuesAndClocks_LeaveOneRow_HoldingTheNewestWrite()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(i =>
            app.PutEntryAsync(login, id, EntryBody(now.AddSeconds(i), weightKg: 70m + i))));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        var row = await db.Set<BodyEntry>().SingleAsync(Ct);
        row.ClientUpdatedAt.Should().Be(TimeStamps.ToStorage(now.AddSeconds(49)));
        row.WeightKg.Should().Be(119m);
    }

    [Fact]
    public async Task ANewerPut_ReplacesTheValues_KeepingTheSameRow_AndAnOlderOneIsIgnored()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutEntryAsync(login, id, EntryBody(now, weightKg: 80m)))
        {
        }

        using var newer = await app.PutEntryAsync(login, id, EntryBody(now.AddMinutes(1), weightKg: 81.5m, waistCm: 84m));
        var newerBody = await TrainingApp.JsonAsync(newer);
        using var older = await app.PutEntryAsync(login, id, EntryBody(now.AddSeconds(-30), weightKg: 70m));
        var olderBody = await TrainingApp.JsonAsync(older);

        newerBody.GetProperty("weightKg").GetDecimal().Should().Be(81.5m);
        newerBody.GetProperty("waistCm").GetDecimal().Should().Be(84m);
        older.StatusCode.Should().Be(HttpStatusCode.OK);
        olderBody.GetProperty("weightKg").GetDecimal().Should().Be(81.5m, "a escrita mais velha devolve o que está guardado");
        await using var db = app.Db();
        (await db.Set<BodyEntry>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task AnEditCanClearAValue_BecauseThePutCarriesTheWholeEntry()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutEntryAsync(login, id, EntryBody(now, weightKg: 80m, waistCm: 84m)))
        {
        }

        using var edit = await app.PutEntryAsync(login, id, EntryBody(now.AddMinutes(1), weightKg: 80m, waistCm: null));
        var body = await TrainingApp.JsonAsync(edit);

        body.GetProperty("waistCm").ValueKind.Should().Be(JsonValueKind.Null);
        body.GetProperty("weightKg").GetDecimal().Should().Be(80m);
    }

    [Fact]
    public async Task Tombstone_EmptiesTheHealthValues_ANewerPutBringsItBack_AndAnOlderOneDoesNot()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutEntryAsync(login, id, EntryBody(now, weightKg: 80m, bodyFatPct: 15m, fatMethod: "manual", note: "segredo")))
        {
        }

        using var removed = await app.PutEntryAsync(
            login, id, EntryBody(now.AddMinutes(1), weightKg: 80m, bodyFatPct: 15m, fatMethod: "manual", note: "segredo", deleted: true));
        var removedBody = await TrainingApp.JsonAsync(removed);
        using var older = await app.PutEntryAsync(login, id, EntryBody(now.AddSeconds(30), weightKg: 99m));
        var olderBody = await TrainingApp.JsonAsync(older);

        removed.StatusCode.Should().Be(HttpStatusCode.OK);
        removedBody.GetProperty("deleted").GetBoolean().Should().BeTrue();
        foreach (var field in new[] { "weightKg", "bodyFatPct", "fatMethod", "waistCm", "note" })
        {
            removedBody.GetProperty(field).ValueKind.Should().Be(JsonValueKind.Null, $"{field}: a lápide não guarda dado de saúde");
        }

        olderBody.GetProperty("deleted").GetBoolean().Should().BeTrue("a lápide mais nova vence a edição mais velha");
        await using (var db = app.Db())
        {
            var row = await db.Set<BodyEntry>().SingleAsync(Ct);
            row.IsDeleted.Should().BeTrue();
            row.WeightKg.Should().BeNull();
            row.Note.Should().BeNull();
        }

        using var back = await app.PutEntryAsync(login, id, EntryBody(now.AddMinutes(2), weightKg: 79m));
        var backBody = await TrainingApp.JsonAsync(back);

        backBody.GetProperty("deleted").GetBoolean().Should().BeFalse();
        backBody.GetProperty("weightKg").GetDecimal().Should().Be(79m);
        await using var check = app.Db();
        (await check.Set<BodyEntry>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task TombstoneOfAnEntryThatNeverArrived_CreatesADeletedRow_EvenWithoutValues_AndAnOlderEditAfterItIsIgnored()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        using var tombstone = await app.PutEntryAsync(login, id, EntryBody(now, weightKg: null, deleted: true));
        using var oldEdit = await app.PutEntryAsync(login, id, EntryBody(now.AddMinutes(-1), weightKg: 80m));

        tombstone.StatusCode.Should().Be(HttpStatusCode.OK, "a lápide vazia não é a medição vazia que se recusa");
        (await TrainingApp.JsonAsync(tombstone)).GetProperty("deleted").GetBoolean().Should().BeTrue();
        (await TrainingApp.JsonAsync(oldEdit)).GetProperty("deleted").GetBoolean().Should().BeTrue();
        await using var db = app.Db();
        var row = await db.Set<BodyEntry>().SingleAsync(Ct);
        row.IsDeleted.Should().BeTrue();
        row.WeightKg.Should().BeNull();
    }

    [Theory]
    [InlineData("weightKg", 19.99, "weightKg")]
    [InlineData("weightKg", 400.01, "weightKg")]
    [InlineData("weightKg", 82.456, "weightKg")]
    [InlineData("bodyFatPct", 1.9, "bodyFatPct")]
    [InlineData("bodyFatPct", 70.1, "bodyFatPct")]
    [InlineData("bodyFatPct", 16.95, "bodyFatPct")]
    [InlineData("waistCm", 9.9, "waistCm")]
    [InlineData("neckCm", 250.1, "neckCm")]
    [InlineData("hipCm", 86.25, "hipCm")]
    [InlineData("armCm", 0, "armCm")]
    [InlineData("thighCm", -5, "thighCm")]
    public async Task ValueOutsideTheLimits_OrWithTooManyDecimals_Returns400_AndNamesTheField_NotTheValue(string field, double value, string expected)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = new Dictionary<string, object?>
        {
            ["measuredOn"] = Today(),
            ["weightKg"] = 80m,
            ["clientUpdatedAt"] = DateTimeOffset.UtcNow,
            ["deleted"] = false,
        };
        body[field] = (decimal)value;
        if (field == "bodyFatPct")
        {
            body["fatMethod"] = "manual";
        }

        using var response = await app.PutEntryAsync(login, Guid.CreateVersion7(), body);
        var text = await response.Content.ReadAsStringAsync(Ct);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var json = JsonDocument.Parse(text);
        json.RootElement.GetProperty("errors").TryGetProperty(expected, out _).Should().BeTrue();
        if (value != Math.Floor(value))
        {
            // Só os valores com casas decimais podem ser procurados no texto: "0" e "-5" apareceriam nos limites ("10 e 250").
            text.Should().NotContain(((decimal)value).ToString(System.Globalization.CultureInfo.InvariantCulture), "o erro não repete o dado de saúde recebido");
        }
    }

    [Fact]
    public async Task TheLimitsThemselves_AreAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        var edges = new[]
        {
            EntryBody(now, weightKg: 20m),
            EntryBody(now, weightKg: 400m),
            EntryBody(now, weightKg: null, bodyFatPct: 2m, fatMethod: "bioimpedance"),
            EntryBody(now, weightKg: null, bodyFatPct: 70m, fatMethod: "navy"),
            EntryBody(now, weightKg: null, waistCm: 10m, thighCm: 250m),
        };
        foreach (var body in edges)
        {
            using var response = await app.PutEntryAsync(login, Guid.CreateVersion7(), body);
            response.StatusCode.Should().Be(HttpStatusCode.OK, System.Text.Json.JsonSerializer.Serialize(body));
        }
    }

    [Fact]
    public async Task TheFatMethod_GoesWithThePercent_AndOnlyWithIt()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        using var noMethod = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, bodyFatPct: 15m, fatMethod: null));
        using var unknown = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, bodyFatPct: 15m, fatMethod: "dobras"));
        using var methodAlone = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, fatMethod: "navy"));

        noMethod.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        unknown.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        methodAlone.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task TheDate_MustBeAfter1900_AndAtMostOneDayAheadOfTheServer()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        using var tomorrow = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, measuredOn: Today(1)));
        using var farFuture = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, measuredOn: Today(2)));
        using var ancient = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, measuredOn: "1899-12-31"));
        using var first = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, measuredOn: "1900-01-01"));
        using var missing = await app.PutEntryAsync(login, Guid.CreateVersion7(), new { weightKg = 80m, clientUpdatedAt = now, deleted = false });

        tomorrow.StatusCode.Should().Be(HttpStatusCode.OK, "o fuso do aparelho pode estar um dia à frente");
        farFuture.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        ancient.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        missing.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task NoteOver300Characters_IsRefused_AndABlankNoteBecomesNull()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        using var tooLong = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, note: new string('a', 301)));
        using var exact = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, note: new string('a', 300)));
        using var blank = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(now, note: "   "));

        tooLong.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        exact.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TrainingApp.JsonAsync(blank)).GetProperty("note").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task MissingClock_OrEmptyId_Returns400()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var noClock = await app.PutEntryAsync(login, Guid.CreateVersion7(), new { measuredOn = Today(), weightKg = 80m, deleted = false });
        using var emptyId = await app.PutEntryAsync(login, Guid.Empty, EntryBody(DateTimeOffset.UtcNow));

        noClock.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        emptyId.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ClockMoreThan24HoursAhead_Returns422_AndJustUnderIsAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var ahead = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(DateTimeOffset.UtcNow.AddHours(25)));
        using var edge = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(DateTimeOffset.UtcNow.AddHours(23)));

        ahead.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(ahead)).Should().EndWith("client-clock-ahead");
        edge.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AnIdOfAnotherUser_Returns404_NeverChangesTheirEntry_AndTheRefusalDoesNotRepeatTheId()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var foreign = NewEntry(Guid.NewGuid(), weightKg: 91m);
        await using (var db = app.Db())
        {
            db.Add(foreign);
            await db.SaveChangesAsync(Ct);
        }

        using var edit = await app.PutEntryAsync(login, foreign.Id, EntryBody(DateTimeOffset.UtcNow.AddMinutes(5), weightKg: 50m));
        using var delete = await app.PutEntryAsync(login, foreign.Id, EntryBody(DateTimeOffset.UtcNow.AddMinutes(6), deleted: true));

        edit.StatusCode.Should().Be(HttpStatusCode.NotFound);
        delete.StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await TrainingAssertions.ProblemTypeAsync(edit)).Should().EndWith("body-entry-not-found");
        (await edit.Content.ReadAsStringAsync(Ct)).Should().NotContain(foreign.Id.ToString());
        await using var check = app.Db();
        var row = await check.Set<BodyEntry>().SingleAsync(e => e.Id == foreign.Id, Ct);
        row.WeightKg.Should().Be(91m);
        row.IsDeleted.Should().BeFalse();
        row.UserId.Should().NotBe(TrainingApp.UserIdOf(login));
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
            var response = await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(DateTimeOffset.UtcNow.AddSeconds(i)));
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
