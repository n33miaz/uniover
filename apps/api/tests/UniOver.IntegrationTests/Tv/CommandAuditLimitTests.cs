using System.Globalization;
using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Audit;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using static UniOver.IntegrationTests.Audit.AuditKit;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// O teto de VOLUME da trilha de comandos: depois de <see cref="EfCommandAudit.DailyLimitPerUser"/> linhas de um usuário no
/// dia (UTC), o comando continua funcionando mas a trilha grava uma única linha de resumo e para até o dia seguinte. Sem
/// o teto, quem manda comando sem parar enche o banco antes de a retenção (30 dias) apagar qualquer coisa.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class CommandAuditLimitTests(PostgresFixture postgres)
{
    private const int Limit = EfCommandAudit.DailyLimitPerUser;

    private static readonly DateTimeOffset Day = new(2026, 10, 14, 0, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Noon = Day.AddHours(12);

    private async Task<TvDbContext> StartAsync()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using (var migrate = TvApp.CreateContext(database.OwnerConnection))
        {
            await migrate.Database.MigrateAsync(Ct);
        }

        return TvApp.CreateContext(database.OwnerConnection);
    }

    private static string SeedSql(Guid user, DateTimeOffset dayStart, int rows)
    {
        var start = dayStart.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        var count = rows.ToString(CultureInfo.InvariantCulture);
        return "INSERT INTO tv.command_audit (id, user_id, tv_id, command, detail, ok, occurred_at) " +
            $"SELECT gen_random_uuid(), '{user}', '00000000-0000-0000-0000-000000000000', 'tv.key', 'HOME', true, '{start}'::timestamptz + g * interval '1 millisecond' " +
            $"FROM generate_series(1, {count}) g";
    }

    private static async Task SeedAsync(TvDbContext db, Guid user, DateTimeOffset dayStart, int rows) =>
        await db.Database.ExecuteSqlRawAsync(SeedSql(user, dayStart, rows), Ct);

    private static CommandAuditEntry Key(Guid user, DateTimeOffset at, string ip = "203.0.113.5") =>
        Command(user, TvCommandNames.Key, "HOME", true, at, ip: ip);

    private static Task<int> RowsOfAsync(TvDbContext db, Guid user, string? command = null) =>
        db.CommandAudit.AsNoTracking().CountAsync(a => a.UserId == user && (command == null || a.Command == command), Ct);

    [Fact]
    public void TheLimit_IsANamedConstant_AndTheSummaryCodeFitsTheColumnAndIsKnownToTheTrail()
    {
        Limit.Should().Be(5000);
        TvCommandNames.AuditLimit.Length.Should().BeLessThanOrEqualTo(CommandAuditEntry.CommandMax);
        TvAuditNormalizer.Actions.Should().Contain(TvCommandNames.AuditLimit, "a trilha do administrador precisa conhecer a anotação");
    }

    [Fact]
    public async Task UnderTheLimit_EveryCommandIsRecorded_WithNoSummary()
    {
        await using var db = await StartAsync();
        var audit = new EfCommandAudit(db);
        var user = Guid.NewGuid();
        await SeedAsync(db, user, Day, Limit - 2);

        await audit.RecordAsync(Key(user, Noon), Ct);
        await audit.RecordAsync(Key(user, Noon.AddSeconds(1)), Ct);

        (await RowsOfAsync(db, user)).Should().Be(Limit);
        (await RowsOfAsync(db, user, TvCommandNames.AuditLimit)).Should().Be(0, "ainda cabe: sem resumo");
        NpgsqlConnection.ClearAllPools();
    }

    [Fact]
    public async Task AtTheLimit_TheTrailWritesASingleSummaryRow_ThenStopsUntilTheNextDay()
    {
        await using var db = await StartAsync();
        var audit = new EfCommandAudit(db);
        var user = Guid.NewGuid();
        await SeedAsync(db, user, Day, Limit - 1);

        await audit.RecordAsync(Key(user, Noon, ip: "203.0.113.1"), Ct);
        (await RowsOfAsync(db, user)).Should().Be(Limit, "a última que cabia");

        await audit.RecordAsync(Key(user, Noon.AddSeconds(1), ip: "203.0.113.2"), Ct);
        await audit.RecordAsync(Key(user, Noon.AddSeconds(2)), Ct);
        await audit.RecordAsync(Key(user, Noon.AddSeconds(3)), Ct);

        (await RowsOfAsync(db, user, TvCommandNames.Key)).Should().Be(Limit, "depois do teto os comandos não viram linha");
        var summary = await db.CommandAudit.AsNoTracking().SingleAsync(a => a.UserId == user && a.Command == TvCommandNames.AuditLimit, Ct);
        summary.Detail.Should().Be("limit=5000");
        summary.Ok.Should().BeTrue("é uma anotação, não um comando que falhou");
        summary.Ip.Should().Be("203.0.113.2", "o IP de quem cruzou o teto");
        (await RowsOfAsync(db, user)).Should().Be(Limit + 1, "o resumo é a única linha a mais");

        // No dia seguinte (UTC) a trilha volta a gravar, e o resumo de ontem não impede o de hoje.
        await audit.RecordAsync(Key(user, Noon.AddDays(1)), Ct);
        (await RowsOfAsync(db, user, TvCommandNames.Key)).Should().Be(Limit + 1);
        (await RowsOfAsync(db, user, TvCommandNames.AuditLimit)).Should().Be(1);
        NpgsqlConnection.ClearAllPools();
    }

    [Fact]
    public async Task TheLimitIsPerUser_AndPerCalendarDay()
    {
        await using var db = await StartAsync();
        var audit = new EfCommandAudit(db);
        var flooder = Guid.NewGuid();
        var other = Guid.NewGuid();
        await SeedAsync(db, flooder, Day, Limit);

        await audit.RecordAsync(Key(flooder, Noon), Ct);
        await audit.RecordAsync(Key(other, Noon), Ct);

        (await RowsOfAsync(db, other, TvCommandNames.Key)).Should().Be(1, "o teto de um usuário não corta o outro");
        (await RowsOfAsync(db, other, TvCommandNames.AuditLimit)).Should().Be(0);
        (await RowsOfAsync(db, flooder, TvCommandNames.AuditLimit)).Should().Be(1);

        // Um dia antes (mesmo usuário): a conta do dia é só do dia da linha.
        await audit.RecordAsync(Key(flooder, Noon.AddDays(-1)), Ct);
        (await RowsOfAsync(db, flooder, TvCommandNames.Key)).Should().Be(Limit + 1);
        NpgsqlConnection.ClearAllPools();
    }

    [Fact]
    public async Task TheSwitchOfTheComputer_IsNeverCutByTheLimit_SoAFloodCannotHideIt()
    {
        await using var db = await StartAsync();
        var audit = new EfCommandAudit(db);
        var user = Guid.NewGuid();
        await SeedAsync(db, user, Day, Limit);

        var bind = CommandAuditEntry.Create(
            user, "pc-novo", TvCommandNames.ConfigBind, "pc-novo", ok: true, errorCode: null, latencyMs: null, new ClientInfo("203.0.113.9", "ua"), Noon);
        await audit.RecordAsync(bind, Ct);

        (await RowsOfAsync(db, user, TvCommandNames.ConfigBind)).Should().Be(1);
        (await RowsOfAsync(db, user, TvCommandNames.AuditLimit)).Should().Be(0, "a troca passa sem acionar o resumo");
        NpgsqlConnection.ClearAllPools();
    }

    [Fact]
    public async Task OverTheHttpRoute_TheCommandsKeepWorking_WhileTheTrailStopsGrowing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await using var identity = app.Identity();
        var owner = await identity.Users.SingleAsync(u => u.Email == app.OwnerEmail, Ct);
        var dayStart = new DateTimeOffset(app.Time.GetUtcNow().UtcDateTime.Date, TimeSpan.Zero);
        await using var db = app.Db();
        await SeedAsync(db, owner.Id, dayStart, Limit - 1);

        for (var i = 0; i < 3; i++)
        {
            var request = app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
            var command = await TvApp.NextCommandAsync(agent);
            await TvApp.ReplyAsync(agent, command);
            using var response = await request.WaitAsync(FakeAgent.Patience, Ct);
            response.StatusCode.Should().Be(HttpStatusCode.OK, $"o comando {i + 1} segue passando mesmo com a trilha no teto");
        }

        (await RowsOfAsync(db, owner.Id, TvCommandNames.Key)).Should().Be(Limit, "só o que coube");
        (await RowsOfAsync(db, owner.Id, TvCommandNames.AuditLimit)).Should().Be(1, "o resumo aparece uma vez só");
        (await RowsOfAsync(db, owner.Id)).Should().Be(Limit + 1);

        // A anotação é da trilha do administrador, não um comando: o histórico curto da TV não a mostra.
        using var recent = await app.GetAsync("/api/v1/tv/commands/recent?limit=100");
        recent.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(recent)).EnumerateArray().Select(e => e.GetProperty("command").GetString())
            .Should().NotContain(TvCommandNames.AuditLimit);
    }
}
