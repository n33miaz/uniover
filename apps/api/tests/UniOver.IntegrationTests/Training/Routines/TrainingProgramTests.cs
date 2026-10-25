using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Features.Routines.ListRoutineTemplates;
using static UniOver.IntegrationTests.Training.Routines.RoutineHelpers;

namespace UniOver.IntegrationTests.Training.Routines;

/// <summary>
/// O programa da semana ativo da conta: um registro próprio, sincronizado, que o aparelho grava pela fila (as fichas do
/// programa viajam como rotinas, com o programa e os dias). Último a escrever vence; um por conta.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TrainingProgramTests(PostgresFixture postgres)
{
    private const string Split = "ppl-superior-inferior";
    private const string FullBody = "full-body-cardio";
    private static readonly string[] TrainingOnly = ["module:training"];
    private static readonly string[] TvOnly = ["module:tv", "tv:control"];
    private static readonly int[] WorkDays = [1, 2, 3, 4, 5];
    private static readonly int[] FullBodyDays = [1, 3, 5];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Task<HttpResponseMessage> SelectAsync(TrainingApp app, LoggedIn? login, string? programId, DateTimeOffset? at = null) =>
        app.SendAsync(HttpMethod.Put, "/api/v1/training/program", new { programId, clientUpdatedAt = at ?? DateTimeOffset.UtcNow }, login?.AccessToken, Guid.NewGuid());

    private static async Task<JsonElement> PullAsync(TrainingApp app, LoggedIn login)
    {
        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/training/program", bearer: login.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return await TrainingApp.JsonAsync(response);
    }

    [Fact]
    public async Task Choosing_SavesTheProgram_AndThePullBringsItToTheOtherDevice()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await SelectAsync(app, login, Split);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var page = await PullAsync(app, login);
        page.GetProperty("items").GetArrayLength().Should().Be(1);
        page.GetProperty("items")[0].GetProperty("programId").GetString().Should().Be(Split);
        page.GetProperty("nextCursor").ValueKind.Should().Be(JsonValueKind.String);
    }

    [Fact]
    public async Task Choosing_AnotherProgram_ReplacesTheChoice_AndAnOlderChoiceNeverWinsOverANewerOne()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;

        (await SelectAsync(app, login, Split, now)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await SelectAsync(app, login, FullBody, now.AddMinutes(1))).StatusCode.Should().Be(HttpStatusCode.OK);
        // Um aparelho atrasado entrega uma escolha mais velha: o servidor guarda a mais nova.
        using var stale = await SelectAsync(app, login, Split, now.AddSeconds(30));

        stale.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TrainingApp.JsonAsync(stale)).GetProperty("programId").GetString().Should().Be(FullBody);
        (await PullAsync(app, login)).GetProperty("items")[0].GetProperty("programId").GetString().Should().Be(FullBody);
    }

    [Fact]
    public async Task TheFirstChoices_ArrivingTogether_EndInASingleRow_WithoutAn500()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var user = TrainingApp.UserIdOf(login);
        var now = DateTimeOffset.UtcNow;

        var responses = await Task.WhenAll(Enumerable.Range(0, 12).Select(i =>
            SelectAsync(app, login, i % 2 == 0 ? Split : FullBody, now.AddSeconds(i))));

        try
        {
            responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        }
        finally
        {
            foreach (var response in responses) response.Dispose();
        }

        await using var db = app.Db();
        var row = await db.Programs.SingleAsync(p => p.UserId == user, Ct);
        row.ProgramId.Should().Be(FullBody, "a escolha mais nova (i = 11) vence");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("nao-existe")]
    [InlineData("historical-ab")]
    public async Task AnUnknownProgram_Returns400_AndSavesNothing(string? programId)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await SelectAsync(app, login, programId);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.Programs.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task AClockMoreThanADayAhead_Returns422()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await SelectAsync(app, login, Split, DateTimeOffset.UtcNow.AddDays(3));

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task ProgramRoutines_KeepTheirProgramAndWeekdays_AndAnOldDeviceDoesNotEraseThem()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        object WithProgram(DateTimeOffset at, string name) => new
        {
            name,
            position = 0,
            active = true,
            note = (string?)null,
            items = new[] { Item(Guid.CreateVersion7(), CatalogId(0), 0) },
            clientUpdatedAt = at,
            deleted = false,
            programId = Split,
            weekdays = new[] { 1 },
        };

        using (var created = await app.PutRoutineAsync(login, id, WithProgram(now, "Segunda · Peito")))
        {
            created.StatusCode.Should().Be(HttpStatusCode.OK);
            var json = await TrainingApp.JsonAsync(created);
            json.GetProperty("programId").GetString().Should().Be(Split);
            json.GetProperty("weekdays").EnumerateArray().Select(d => d.GetInt32()).Should().Equal(1);
        }

        // Um corpo sem programa nem dias (aparelho antigo) não apaga o que já estava.
        using (var edited = await app.PutRoutineAsync(login, id, Body(now.AddMinutes(1), name: "Segunda · Editada")))
        {
            edited.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await using var db = app.Db();
        var row = await db.Set<Routine>().SingleAsync(r => r.Id == id, Ct);
        row.Name.Should().Be("Segunda · Editada");
        row.ProgramId.Should().Be(Split);
        row.Weekdays.Should().Equal(1);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(8)]
    public async Task AWeekdayOutOfRange_Returns400(int day)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PutRoutineAsync(login, Guid.CreateVersion7(), new
        {
            name = "A",
            position = 0,
            active = true,
            items = new[] { Item(Guid.CreateVersion7(), CatalogId(0), 0) },
            clientUpdatedAt = DateTimeOffset.UtcNow,
            deleted = false,
            weekdays = new[] { day },
        });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task EachAccountHasItsOwnProgram_OwnerAndTrainingGuest()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await app.NewGuestAsync("Raphael", TrainingOnly, 61);

        (await SelectAsync(app, owner, Split)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await SelectAsync(app, guest.Login, FullBody)).StatusCode.Should().Be(HttpStatusCode.OK);

        (await PullAsync(app, owner)).GetProperty("items")[0].GetProperty("programId").GetString().Should().Be(Split);
        (await PullAsync(app, guest.Login)).GetProperty("items")[0].GetProperty("programId").GetString().Should().Be(FullBody);
        await using var db = app.Db();
        (await db.Programs.CountAsync(Ct)).Should().Be(2);
    }

    [Fact]
    public async Task WithoutLogin_Returns401_AndAGuestWithoutTheTrainingModule_Returns403()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var tvGuest = await app.NewGuestAsync("So TV", TvOnly, 62);

        using var anonymous = await SelectAsync(app, null, Split);
        using var forbidden = await SelectAsync(app, tvGuest.Login, Split);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        forbidden.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Migration_AddsTheProgramColumnsAndTable_KeepsOldRoutines_AndTheRuntimeRoleCanUseThem()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { MigrateTraining = false });
        await using (var training = TrainingApp.CreateContext(app.Database.OwnerConnection))
        {
            await training.Database.MigrateAsync("20261022124339_AddFoods", Ct);
            await using (var owner = new NpgsqlConnection(app.Database.OwnerConnection))
            {
                await owner.OpenAsync(Ct);
                await using var insert = new NpgsqlCommand(
                    "INSERT INTO training.routines (id, user_id, name, position, active, created_at, updated_at, client_updated_at) "
                    + "VALUES (gen_random_uuid(), gen_random_uuid(), 'A', 0, true, now(), now(), now())", owner);
                (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);
            }

            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().Equal("20261024120000_AddTrainingPrograms", "20261024130000_AddProgressPhotos");
            await training.Database.MigrateAsync(Ct);
            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().BeEmpty();
        }

        await using var connection = new NpgsqlConnection(app.Database.RuntimeConnection);
        await connection.OpenAsync(Ct);
        await using (var read = new NpgsqlCommand("SELECT program_id, cardinality(weekdays) FROM training.routines", connection))
        await using (var reader = await read.ExecuteReaderAsync(Ct))
        {
            (await reader.ReadAsync(Ct)).Should().BeTrue();
            reader.IsDBNull(0).Should().BeTrue("a ficha antiga continua livre, sem programa");
            reader.GetInt32(1).Should().Be(0, "e sem dias");
        }

        await using (var insert = new NpgsqlCommand(
            "INSERT INTO training.programs (user_id, program_id, updated_at, client_updated_at) VALUES (gen_random_uuid(), 'x', now(), now())", connection))
        {
            (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        await using var ddl = new NpgsqlCommand("CREATE TABLE training.programs_intruder (id int)", connection);
        (await Assert.ThrowsAsync<PostgresException>(() => ddl.ExecuteNonQueryAsync(Ct))).SqlState.Should().Be("42501");
    }

    [Fact]
    public void TheTrainingModel_MatchesTheLastMigrationSnapshot()
    {
        // A migration escrita à mão (sem Designer) precisa deixar o snapshot igual ao modelo do código.
        using var context = TrainingApp.CreateContext("Host=localhost;Database=unused;Username=unused;Password=unused");

        context.Database.HasPendingModelChanges().Should().BeFalse("o modelo do código e o último snapshot de migration precisam coincidir");
    }

    [Fact]
    public void TheSeed_EveryTemplateThatCanBeAProgramDeclaresItsWeekdays_AndTheWeekendRests()
    {
        var programs = RoutineTemplateSource.Read().Items.Where(t => t.Id != "historical-ab").ToList();
        programs.Should().HaveCount(8);

        foreach (var program in programs)
        {
            program.Routines.Should().OnlyContain(r => r.Weekdays != null && r.Weekdays.Count > 0, program.Id);
            var days = program.Routines.SelectMany(r => r.Weekdays!).Distinct().ToList();
            days.Should().OnlyContain(d => d >= 1 && d <= 5, program.Id + ": sábado e domingo são descanso");
        }

        // Divisões de um dia por ficha: nenhum dia repete.
        foreach (var program in new[] { Split, "superior-inferior-acessorios", "divisao-familiar-reforco-inferior", FullBody, "abc", "abcd" })
        {
            var days = programs.Single(t => t.Id == program).Routines.SelectMany(r => r.Weekdays!).ToList();
            days.Should().OnlyHaveUniqueItems(program);
        }

        programs.Single(t => t.Id == FullBody).Routines.Select(r => r.Weekdays!.Single()).Should().Equal(1, 3, 5);

        // A/B alternam nos dias de treino: as duas fichas valem seg–sex e o aparelho escolhe pela sequência.
        programs.Single(t => t.Id == "ab-reajustado").Routines.Should().OnlyContain(r => r.Weekdays!.SequenceEqual(WorkDays));
        programs.Single(t => t.Id == "full-body").Routines.Should().OnlyContain(r => r.Weekdays!.SequenceEqual(FullBodyDays));
    }
}
