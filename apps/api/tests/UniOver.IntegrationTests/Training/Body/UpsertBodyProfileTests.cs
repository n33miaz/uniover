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
public sealed class UpsertBodyProfileTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PutProfileAsync(null, ProfileBody(DateTimeOffset.UtcNow));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Put_CreatesTheProfileOfTheCaller_KeyedByTheUser_WithTheDefaultActivityFactor()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var stamp = DateTimeOffset.UtcNow;

        using var response = await app.PutProfileAsync(login, ProfileBody(stamp, activityFactor: null));
        var body = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        body.GetProperty("heightCm").GetDecimal().Should().Be(180m);
        body.GetProperty("birthDate").GetString().Should().Be("1995-06-15");
        body.GetProperty("sex").GetString().Should().Be("male");
        body.GetProperty("activityFactor").GetDecimal().Should().Be(1.55m, "sem fator, vale o padrão");
        await using var db = app.Db();
        var row = await db.Set<BodyProfile>().SingleAsync(Ct);
        row.UserId.Should().Be(TrainingApp.UserIdOf(login), "a chave natural é o usuário da sessão");
        row.ClientUpdatedAt.Should().Be(TimeStamps.ToStorage(stamp));
    }

    [Fact]
    public async Task SameKey_SameBody_ReplaysTheStoredResponse_DifferentBodyReturns422_MissingKeyRunsWithoutReplay()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var body = ProfileBody(now);

        using var first = await app.PutProfileAsync(login, body, key);
        using var second = await app.PutProfileAsync(login, body, key);
        using var reused = await app.PutProfileAsync(login, ProfileBody(now, heightCm: 181m), key);
        using var missing = await app.SendAsync(HttpMethod.Put, "/api/v1/training/body/profile", body, login.AccessToken);

        Replayed(first).Should().BeFalse();
        Replayed(second).Should().BeTrue();
        (await second.Content.ReadAsStringAsync(Ct)).Should().Be(await first.Content.ReadAsStringAsync(Ct));
        reused.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(reused)).Should().EndWith("idempotency-key-reused");
        missing.StatusCode.Should().Be(HttpStatusCode.OK, "sem chave a escrita segue sem proteção, nesta transição");
        missing.Headers.Contains("Idempotent-Replayed").Should().BeFalse();
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithTheSameKey_LeaveOneRow_AndNoServerError()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();
        var body = ProfileBody(DateTimeOffset.UtcNow);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutProfileAsync(login, body, key)));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK || r.StatusCode == HttpStatusCode.Conflict);
        responses.Should().Contain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Set<BodyProfile>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithFiftyDifferentKeys_LeaveOneRow_AndAllSucceed()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = ProfileBody(DateTimeOffset.UtcNow);

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => app.PutProfileAsync(login, body, Guid.NewGuid())));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK, "quem perde a corrida pela chave primária relê e conclui");
        await using var db = app.Db();
        (await db.Set<BodyProfile>().CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task FiftySimultaneousPuts_WithDifferentValuesAndClocks_LeaveOneRow_HoldingTheNewestWrite()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(i =>
            app.PutProfileAsync(login, ProfileBody(now.AddSeconds(i), heightCm: 150m + i))));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        var row = await db.Set<BodyProfile>().SingleAsync(Ct);
        row.ClientUpdatedAt.Should().Be(TimeStamps.ToStorage(now.AddSeconds(49)));
        row.HeightCm.Should().Be(199m);
    }

    [Fact]
    public async Task ANewerPut_ReplacesTheProfile_AndAnOlderOneIsIgnored()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutProfileAsync(login, ProfileBody(now)))
        {
        }

        using var newer = await app.PutProfileAsync(login, ProfileBody(now.AddMinutes(1), heightCm: 181.5m, sex: "female", activityFactor: 1.2m));
        using var older = await app.PutProfileAsync(login, ProfileBody(now.AddSeconds(-30), heightCm: 170m));
        var olderBody = await TrainingApp.JsonAsync(older);

        (await TrainingApp.JsonAsync(newer)).GetProperty("sex").GetString().Should().Be("female");
        older.StatusCode.Should().Be(HttpStatusCode.OK);
        olderBody.GetProperty("heightCm").GetDecimal().Should().Be(181.5m, "a escrita mais velha devolve o que está guardado");
        olderBody.GetProperty("activityFactor").GetDecimal().Should().Be(1.2m);
        await using var db = app.Db();
        (await db.Set<BodyProfile>().CountAsync(Ct)).Should().Be(1);
    }

    [Theory]
    [InlineData("heightCm", 99.9)]
    [InlineData("heightCm", 250.1)]
    [InlineData("heightCm", 180.55)]
    [InlineData("activityFactor", 0.99)]
    [InlineData("activityFactor", 2.51)]
    [InlineData("activityFactor", 1.555)]
    public async Task NumberOutsideTheLimits_OrWithTooManyDecimals_Returns400_AndNamesTheField_NotTheValue(string field, double value)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = new Dictionary<string, object?>
        {
            ["heightCm"] = 180m,
            ["birthDate"] = "1995-06-15",
            ["sex"] = "male",
            ["activityFactor"] = 1.55m,
            ["clientUpdatedAt"] = DateTimeOffset.UtcNow,
        };
        body[field] = (decimal)value;

        using var response = await app.PutProfileAsync(login, body);
        var text = await response.Content.ReadAsStringAsync(Ct);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var json = JsonDocument.Parse(text);
        json.RootElement.GetProperty("errors").TryGetProperty(field, out _).Should().BeTrue();
        text.Should().NotContain(((decimal)value).ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task TheLimitsThemselves_AreAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        foreach (var body in new[]
        {
            ProfileBody(now, heightCm: 100m, activityFactor: 1.0m),
            ProfileBody(now.AddSeconds(1), heightCm: 250m, activityFactor: 2.5m),
            ProfileBody(now.AddSeconds(2), birthDate: "1900-01-01"),
            ProfileBody(now.AddSeconds(3), birthDate: Today()),
        })
        {
            using var response = await app.PutProfileAsync(login, body);
            response.StatusCode.Should().Be(HttpStatusCode.OK, JsonSerializer.Serialize(body));
        }
    }

    [Fact]
    public async Task BirthDate_SexAndRequiredFields_AreValidated_AndAMinorIsNotRefused()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        using var future = await app.PutProfileAsync(login, ProfileBody(now, birthDate: Today(1)));
        using var ancient = await app.PutProfileAsync(login, ProfileBody(now, birthDate: "1899-12-31"));
        using var noBirth = await app.PutProfileAsync(login, ProfileBody(now, birthDate: null));
        using var noHeight = await app.PutProfileAsync(login, ProfileBody(now, heightCm: null));
        using var badSex = await app.PutProfileAsync(login, ProfileBody(now, sex: "outro"));
        using var noSex = await app.PutProfileAsync(login, ProfileBody(now, sex: null));
        using var noClock = await app.PutProfileAsync(login, new { heightCm = 180m, birthDate = "1995-06-15", sex = "male" });
        using var minor = await app.PutProfileAsync(login, ProfileBody(now.AddSeconds(1), birthDate: "2015-01-01"));

        foreach (var refused in new[] { future, ancient, noBirth, noHeight, badSex, noSex, noClock })
        {
            refused.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        minor.StatusCode.Should().Be(HttpStatusCode.OK, "o registro é livre: quem deixa de calcular abaixo de 18 anos é o aparelho");
    }

    [Fact]
    public async Task ClockMoreThan24HoursAhead_Returns422_AndJustUnderIsAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var ahead = await app.PutProfileAsync(login, ProfileBody(DateTimeOffset.UtcNow.AddHours(25)));
        using var edge = await app.PutProfileAsync(login, ProfileBody(DateTimeOffset.UtcNow.AddHours(23)));

        ahead.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(ahead)).Should().EndWith("client-clock-ahead");
        edge.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task TwoUsers_NeverShareAProfile()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var foreign = NewProfile(Guid.NewGuid());
        await using (var db = app.Db())
        {
            db.Add(foreign);
            await db.SaveChangesAsync(Ct);
        }

        using var response = await app.PutProfileAsync(login, ProfileBody(DateTimeOffset.UtcNow.AddMinutes(5), heightCm: 190m));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = app.Db();
        (await check.Set<BodyProfile>().CountAsync(Ct)).Should().Be(2);
        var untouched = await check.Set<BodyProfile>().SingleAsync(p => p.UserId == foreign.UserId, Ct);
        untouched.HeightCm.Should().Be(175m, "o perfil de outra pessoa não é tocado");
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
            var response = await app.PutProfileAsync(login, ProfileBody(DateTimeOffset.UtcNow.AddSeconds(i)));
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
        limited.Dispose();
    }
}
