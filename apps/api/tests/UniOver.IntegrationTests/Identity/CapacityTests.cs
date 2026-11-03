using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.Capacity;

namespace UniOver.IntegrationTests.Identity;

/// <summary>
/// O cartão de capacidade: só o dono lê; o tamanho vem do catálogo do Postgres (com o papel da aplicação, sem DDL); a
/// amostra diária fica uma por dia, a retenção é de 120 dias e o aviso abre uma vez só por métrica no vermelho.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class CapacityTests(PostgresFixture postgres)
{
    private const string Route = "/api/v1/identity/capacity";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static IdentityAppOptions With(params (string Key, string Value)[] settings) => new()
    {
        Extra = settings.ToDictionary(s => "Modules:Identity:Capacity:" + s.Key, s => (string?)s.Value),
    };

    /// <summary>Roda o serviço de retenção uma vez (com o papel runtime) e devolve o que a amostra de capacidade fez.</summary>
    private static async Task<AuditPurgeResult> RunJobAsync(IdentityApp app)
    {
        var results = await app.Services.GetRequiredService<AuditPurgeService>().RunOnceAsync(Ct);
        return results.Single(r => r.Name == CapacitySampling.JobName);
    }

    [Fact]
    public async Task OnlyTheOwnerReadsIt_AnonymousIs401_AndAGuestIs403()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var anonymous = await app.SendAsync(HttpMethod.Get, Route);
        using var asGuest = await app.SendAsync(HttpMethod.Get, Route, bearer: guest.Login.AccessToken);
        using var markAnonymous = await app.SendAsync(HttpMethod.Post, Route + "/alerts/seen");
        using var markGuest = await app.SendAsync(HttpMethod.Post, Route + "/alerts/seen", bearer: guest.Login.AccessToken);
        using var asOwner = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        markAnonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        markGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        asOwner.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task TheOwnerSeesTheDatabase_TheLargestTables_AndTheServer()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(response);
        var database = body.GetProperty("database");
        database.GetProperty("bytes").GetInt64().Should().BeGreaterThan(0);
        database.GetProperty("limitBytes").GetInt64().Should().Be(1024L * 1024 * 1024);
        database.GetProperty("band").GetString().Should().Be("green");
        var tables = database.GetProperty("tables").EnumerateArray().ToList();
        tables.Should().NotBeEmpty().And.HaveCountLessThanOrEqualTo(CapacitySampling.TopTables);
        tables.Select(t => t.GetProperty("schema").GetString()).Should().OnlyContain(s => s == "identity");
        tables.Select(t => t.GetProperty("bytes").GetInt64()).Should().BeInDescendingOrder();

        var server = body.GetProperty("server");
        server.GetProperty("workingSetBytes").GetInt64().Should().BeGreaterThan(0);
        server.GetProperty("memoryLimitBytes").GetInt64().Should().Be(512L * 1024 * 1024);
        server.GetProperty("hoursLimit").GetInt32().Should().Be(750);
        server.GetProperty("uptimeSeconds").GetInt64().Should().BeGreaterThanOrEqualTo(0);
        body.GetProperty("growth").GetProperty("state").GetString().Should().Be("few");
        body.GetProperty("alerts").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task WithTinyLimits_TheBandsTurnRed()
    {
        await using var app = await IdentityApp.StartAsync(postgres, With(("DatabaseLimitBytes", "1024"), ("MemoryLimitMb", "1")));
        var owner = await app.LoginAsync();

        using var response = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);

        var body = await IdentityApp.JsonAsync(response);
        body.GetProperty("database").GetProperty("band").GetString().Should().Be("red");
        body.GetProperty("server").GetProperty("memoryBand").GetString().Should().Be("red");
    }

    [Fact]
    public async Task TheDailyJob_RunsWithTheRuntimeRole_AndKeepsOneSamplePerDay()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        (await RunJobAsync(app)).Succeeded.Should().BeTrue();
        (await RunJobAsync(app)).Succeeded.Should().BeTrue();

        await using var db = app.Db();
        var samples = await db.CapacitySamples.ToListAsync(Ct);
        samples.Should().ContainSingle();
        samples[0].DatabaseBytes.Should().BeGreaterThan(0);
        samples[0].Day.Should().Be(DateOnly.FromDateTime(app.Time.GetUtcNow().UtcDateTime));

        // Dia seguinte: um processo novo sobre o mesmo banco (como depois de um deploy) acrescenta a segunda amostra.
        await using var nextDay = await IdentityApp.StartAsync(
            postgres, new IdentityAppOptions { Database = app.Database, Start = app.Time.GetUtcNow().AddDays(1) });
        (await RunJobAsync(nextDay)).Succeeded.Should().BeTrue();

        (await db.CapacitySamples.AsNoTracking().CountAsync(Ct)).Should().Be(2);
    }

    [Fact]
    public async Task TheJob_DeletesSamplesOlderThanTheRetention_AndKeepsTheRest()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var today = DateOnly.FromDateTime(app.Time.GetUtcNow().UtcDateTime);
        await using (var seed = app.Db())
        {
            seed.CapacitySamples.AddRange(
                new CapacitySample { Day = today.AddDays(-121), DatabaseBytes = 1, TakenAt = app.Time.GetUtcNow().AddDays(-121) },
                new CapacitySample { Day = today.AddDays(-120), DatabaseBytes = 2, TakenAt = app.Time.GetUtcNow().AddDays(-120) },
                new CapacitySample { Day = today.AddDays(-119), DatabaseBytes = 3, TakenAt = app.Time.GetUtcNow().AddDays(-119) });
            await seed.SaveChangesAsync(Ct);
        }

        var result = await RunJobAsync(app);

        result.Succeeded.Should().BeTrue();
        result.Removed.Should().Be(1);
        await using var db = app.Db();
        (await db.CapacitySamples.AsNoTracking().Select(s => s.Day).ToListAsync(Ct))
            .Should().BeEquivalentTo([today.AddDays(-120), today.AddDays(-119), today]);
    }

    [Fact]
    public async Task TheTrend_UsesTheDailySamples_AndTheEndpointExposesIt()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var today = DateOnly.FromDateTime(app.Time.GetUtcNow().UtcDateTime);
        await using (var seed = app.Db())
        {
            // Quatro dias a 1 MiB por dia, terminando ontem; o dia de hoje vem da leitura ao vivo.
            for (var i = 4; i >= 1; i--)
            {
                seed.CapacitySamples.Add(new CapacitySample
                {
                    Day = today.AddDays(-i), DatabaseBytes = (20 - i) * 1024L * 1024, TakenAt = app.Time.GetUtcNow().AddDays(-i),
                });
            }

            await seed.SaveChangesAsync(Ct);
        }

        using var response = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);

        var growth = (await IdentityApp.JsonAsync(response)).GetProperty("growth");
        growth.GetProperty("state").GetString().Should().Be("growing");
        growth.GetProperty("points").GetArrayLength().Should().Be(4);
        growth.GetProperty("bytesPerDay").GetDouble().Should().BeApproximately(1024 * 1024, 1);
        growth.GetProperty("daysToRed").GetDouble().Should().BeGreaterThan(growth.GetProperty("daysToAmber").GetDouble());
    }

    [Fact]
    public async Task ARedMetric_OpensOneAlert_NotOnePerRun_AndTheOwnerCanDismissIt()
    {
        await using var app = await IdentityApp.StartAsync(postgres, With(("DatabaseLimitBytes", "1024")));
        var owner = await app.LoginAsync();

        await RunJobAsync(app);
        await RunJobAsync(app);

        await using (var db = app.Db())
        {
            var alerts = await db.CapacityAlerts.AsNoTracking().Where(a => a.Metric == "database").ToListAsync(Ct);
            alerts.Should().ContainSingle();
            alerts[0].RecoveredAt.Should().BeNull();
            alerts[0].Percent.Should().BeGreaterThanOrEqualTo(80);
        }

        using var listed = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var listedAlerts = (await IdentityApp.JsonAsync(listed)).GetProperty("alerts").EnumerateArray().ToList();
        listedAlerts.Select(a => a.GetProperty("metric").GetString()).Should().Contain("database");

        using var seen = await app.SendAsync(HttpMethod.Post, Route + "/alerts/seen", bearer: owner.AccessToken);
        seen.StatusCode.Should().Be(HttpStatusCode.NoContent);
        using var after = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        (await IdentityApp.JsonAsync(after)).GetProperty("alerts").GetArrayLength().Should().Be(0);

        // Dispensado, mas a métrica segue no vermelho: o mesmo aviso (já visto) não reabre a cada execução.
        await RunJobAsync(app);
        await using var check = app.Db();
        (await check.CapacityAlerts.AsNoTracking().CountAsync(a => a.Metric == "database", Ct)).Should().Be(1);
    }

    [Fact]
    public async Task TheAlert_HasHysteresis_ClosesOnlyBelowSeventyFive_AndCoolsDownBeforeReopening()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        await using var db = IdentityApp.CreateContext(app.Database.RuntimeConnection);

        await CapacitySampling.EvaluateAlertsAsync(db, new Dictionary<string, double> { ["database"] = 85 }, now, Ct);
        (await db.CapacityAlerts.CountAsync(Ct)).Should().Be(1);

        // Entre 75% e 80% o aviso aberto fica como está: oscilar em torno de 80% não o fecha.
        await CapacitySampling.EvaluateAlertsAsync(db, new Dictionary<string, double> { ["database"] = 78 }, now.AddHours(1), Ct);
        (await db.CapacityAlerts.SingleAsync(Ct)).RecoveredAt.Should().BeNull();
        await CapacitySampling.EvaluateAlertsAsync(db, new Dictionary<string, double> { ["database"] = 82 }, now.AddHours(2), Ct);
        (await db.CapacityAlerts.CountAsync(Ct)).Should().Be(1);

        // Abaixo de 75% fecha.
        await CapacitySampling.EvaluateAlertsAsync(db, new Dictionary<string, double> { ["database"] = 74.9 }, now.AddHours(3), Ct);
        (await db.CapacityAlerts.SingleAsync(Ct)).RecoveredAt.Should().Be(now.AddHours(3));

        // De volta ao vermelho dentro do cooldown: nenhum aviso novo.
        await CapacitySampling.EvaluateAlertsAsync(db, new Dictionary<string, double> { ["database"] = 99 }, now.AddHours(4), Ct);
        (await db.CapacityAlerts.CountAsync(Ct)).Should().Be(1);
        await CapacitySampling.EvaluateAlertsAsync(
            db, new Dictionary<string, double> { ["database"] = 99 }, now.AddHours(3) + CapacityBands.AlertCooldown - TimeSpan.FromMinutes(1), Ct);
        (await db.CapacityAlerts.CountAsync(Ct)).Should().Be(1);

        // Passado o cooldown, abre um novo.
        await CapacitySampling.EvaluateAlertsAsync(
            db, new Dictionary<string, double> { ["database"] = 99 }, now.AddHours(3) + CapacityBands.AlertCooldown + TimeSpan.FromMinutes(1), Ct);
        (await db.CapacityAlerts.CountAsync(Ct)).Should().Be(2);
        (await db.CapacityAlerts.CountAsync(a => a.RecoveredAt == null, Ct)).Should().Be(1);

        // Exatamente 80% já é vermelho; 79,99% não abre aviso para quem não tem um aberto.
        await CapacitySampling.EvaluateAlertsAsync(
            db, new Dictionary<string, double> { ["memory"] = 79.99, ["hours"] = 80 }, now.AddDays(30), Ct);
        (await db.CapacityAlerts.Where(a => a.RecoveredAt == null).Select(a => a.Metric).ToListAsync(Ct))
            .Should().BeEquivalentTo(["database", "hours"]);
    }

    [Fact]
    public async Task Dismissing_OnlyTouchesTheOpenAlerts()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var now = app.Time.GetUtcNow();
        await using (var seed = app.Db())
        {
            seed.CapacityAlerts.AddRange(
                new CapacityAlert { Id = Guid.NewGuid(), Metric = "memory", Percent = 90, DetectedAt = now.AddDays(-2), RecoveredAt = now.AddDays(-1) },
                new CapacityAlert { Id = Guid.NewGuid(), Metric = "database", Percent = 85, DetectedAt = now.AddHours(-1) });
            await seed.SaveChangesAsync(Ct);
        }

        using var seen = await app.SendAsync(HttpMethod.Post, Route + "/alerts/seen", bearer: owner.AccessToken);

        seen.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        (await db.CapacityAlerts.AsNoTracking().SingleAsync(a => a.Metric == "database", Ct)).SeenAt.Should().NotBeNull();
        (await db.CapacityAlerts.AsNoTracking().SingleAsync(a => a.Metric == "memory", Ct)).SeenAt.Should().BeNull();
    }

    [Fact]
    public async Task TheDatabaseMeasure_IsReusedWithinTheCacheLifetime_AndTheRouteHasItsOwnLowLimit()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var first = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var firstAt = (await IdentityApp.JsonAsync(first)).GetProperty("measuredAt").GetDateTimeOffset();
        app.Time.Advance(TimeSpan.FromMinutes(1));
        using var second = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var secondAt = (await IdentityApp.JsonAsync(second)).GetProperty("measuredAt").GetDateTimeOffset();

        // Dentro dos 10 minutos a medida do banco é a mesma (o instante dela, não o da leitura).
        secondAt.Should().Be(firstAt);

        // A rota tem balde próprio de 6 por minuto, por conta: as quatro seguintes passam e a sétima é recusada.
        for (var i = 0; i < 4; i++)
        {
            using var ok = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
            ok.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var limited = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task WithTheCacheOff_EveryReadMeasuresTheDatabaseAgain()
    {
        await using var app = await IdentityApp.StartAsync(postgres, With(("DatabaseCacheMinutes", "0")));
        var owner = await app.LoginAsync();

        using var first = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var firstAt = (await IdentityApp.JsonAsync(first)).GetProperty("measuredAt").GetDateTimeOffset();
        app.Time.Advance(TimeSpan.FromMinutes(1));
        using var second = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var secondAt = (await IdentityApp.JsonAsync(second)).GetProperty("measuredAt").GetDateTimeOffset();

        secondAt.Should().Be(firstAt.AddMinutes(1));
    }

    [Fact]
    public async Task TwoProcessesSamplingTheSameDayAtOnce_LeaveOneSampleAndOneAlertPerMetric()
    {
        await using var first = await IdentityApp.StartAsync(postgres, With(("DatabaseLimitBytes", "1024")));
        await using var second = await IdentityApp.StartAsync(
            postgres, new IdentityAppOptions
            {
                Database = first.Database,
                Start = first.Time.GetUtcNow(),
                Extra = new Dictionary<string, string?> { ["Modules:Identity:Capacity:DatabaseLimitBytes"] = "1024" },
            });

        // Seis execuções ao mesmo tempo, três em cada processo: todas terminam sem falha.
        var runs = await Task.WhenAll(Enumerable.Range(0, 6).Select(i => Task.Run(() => RunJobAsync(i % 2 == 0 ? first : second), Ct)));

        runs.Should().OnlyContain(r => r.Succeeded);
        await using var db = first.Db();
        (await db.CapacitySamples.AsNoTracking().CountAsync(Ct)).Should().Be(1);
        var open = await db.CapacityAlerts.AsNoTracking().Where(a => a.RecoveredAt == null).Select(a => a.Metric).ToListAsync(Ct);
        open.Should().OnlyHaveUniqueItems().And.Contain("database");
    }

    [Fact]
    public async Task TheMonthHours_AreInformativeWithOneService_AndNeverOpenAnAlert()
    {
        // 29/10 às 12h: 28,5 dias x 24 = 684 h (91% de 750), mas a projeção do mês é 744 h e cabe.
        await using var app = await IdentityApp.StartAsync(
            postgres, new IdentityAppOptions { Start = new DateTimeOffset(2026, 10, 29, 12, 0, 0, TimeSpan.Zero) });
        var owner = await app.LoginAsync();

        await RunJobAsync(app);

        await using (var db = app.Db())
        {
            (await db.CapacityAlerts.AsNoTracking().CountAsync(a => a.Metric == "hours", Ct)).Should().Be(0);
        }

        using var response = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var server = (await IdentityApp.JsonAsync(response)).GetProperty("server");
        server.GetProperty("monthHours").GetDouble().Should().Be(684);
        server.GetProperty("hoursBand").GetString().Should().Be("neutral");
        server.GetProperty("hoursProjected").GetDouble().Should().Be(744);
        server.GetProperty("servicesInWorkspace").GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task WithTwoServices_TheProjectedMonthPassesTheLimit_OpensTheAlertAndTurnsRed_UntilTheCountGoesBack()
    {
        var start = new DateTimeOffset(2026, 10, 3, 12, 0, 0, TimeSpan.Zero);
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions
        {
            Start = start,
            Extra = new Dictionary<string, string?> { ["Modules:Identity:Capacity:ServicesInWorkspace"] = "2" },
        });
        var owner = await app.LoginAsync();

        await RunJobAsync(app);
        await RunJobAsync(app);

        await using (var db = app.Db())
        {
            var alert = await db.CapacityAlerts.AsNoTracking().SingleAsync(a => a.Metric == "hours", Ct);
            alert.RecoveredAt.Should().BeNull();
            alert.Percent.Should().BeGreaterThanOrEqualTo(100);
        }

        using var response = await app.SendAsync(HttpMethod.Get, Route, bearer: owner.AccessToken);
        var body = await IdentityApp.JsonAsync(response);
        body.GetProperty("server").GetProperty("hoursBand").GetString().Should().Be("red");
        body.GetProperty("server").GetProperty("hoursProjected").GetDouble().Should().Be(1488);
        body.GetProperty("alerts").EnumerateArray().Select(a => a.GetProperty("metric").GetString()).Should().Contain("hours");

        // Outro processo sobre o mesmo banco, de volta a um serviço só: a projeção cabe e o aviso fecha.
        await using var back = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { Database = app.Database, Start = start });
        await RunJobAsync(back);
        await using var after = app.Db();
        (await after.CapacityAlerts.AsNoTracking().SingleAsync(a => a.Metric == "hours", Ct)).RecoveredAt.Should().NotBeNull();
    }
}
