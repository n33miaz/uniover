using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Body;
using static UniOver.IntegrationTests.Training.BodyMetrics.BodyHelpers;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.BodyMetrics;

/// <summary>As medidas acrescentadas ao corpo: tórax, abdômen, antebraço, panturrilha, lados direito/esquerdo e dobras.</summary>
[Collection(PostgresGroup.Name)]
public sealed class BodyMeasurementsTests(PostgresFixture postgres)
{
    private const string PreviousMigration = "20261024130000_AddProgressPhotos";

    private static readonly string[] CircumferenceFields =
    [
        "chestCm", "abdomenCm", "forearmCm", "calfCm", "armRightCm", "armLeftCm", "forearmRightCm", "forearmLeftCm",
        "thighRightCm", "thighLeftCm", "calfRightCm", "calfLeftCm",
    ];

    private static readonly string[] SkinfoldFields = ["chestSkinfoldMm", "abdomenSkinfoldMm", "thighSkinfoldMm"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Dictionary<string, object?> Body(DateTimeOffset stamp, decimal? weightKg = null) => new()
    {
        ["measuredOn"] = Today(),
        ["weightKg"] = weightKg,
        ["clientUpdatedAt"] = stamp,
        ["deleted"] = false,
    };

    [Fact]
    public async Task TheNewMeasurements_AreStoredAndReturned_AndTheyAloneAreEnoughForAnEntry()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var body = Body(DateTimeOffset.UtcNow);
        var expected = new Dictionary<string, decimal>();
        var next = 30.5m;
        foreach (var field in CircumferenceFields)
        {
            body[field] = next;
            expected[field] = next;
            next += 1.5m;
        }

        foreach (var field in SkinfoldFields)
        {
            body[field] = 12.5m;
            expected[field] = 12.5m;
        }

        using var response = await app.PutEntryAsync(login, id, body);
        var json = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK, "sem peso nem outro valor antigo: as medidas novas contam como valor");
        foreach (var (field, value) in expected)
        {
            json.GetProperty(field).GetDecimal().Should().Be(value, field);
        }

        await using var db = app.Db();
        var row = await db.Set<BodyEntry>().SingleAsync(e => e.Id == id, Ct);
        row.ChestCm.Should().Be(30.5m);
        row.ArmRightCm.Should().Be(expected["armRightCm"]);
        row.ThighSkinfoldMm.Should().Be(12.5m);
    }

    [Fact]
    public async Task AClientThatKnowsNothingOfTheNewFields_StillWrites_AndGetsThemBackAsNull()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        // O corpo de um cliente anterior: só os campos antigos.
        using var response = await app.PutEntryAsync(
            login, Guid.CreateVersion7(), EntryBody(DateTimeOffset.UtcNow, weightKg: 81m, waistCm: 85m, armCm: 34m, thighCm: 57m));
        var json = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        json.GetProperty("armCm").GetDecimal().Should().Be(34m, "o campo sem lado continua valendo como antes");
        foreach (var field in CircumferenceFields.Concat(SkinfoldFields))
        {
            json.GetProperty(field).ValueKind.Should().Be(JsonValueKind.Null, field);
        }
    }

    [Fact]
    public async Task ANewerPutReplacesTheNewValues_AnOlderOneIsIgnored_AndAnEditCanClearThem()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        var first = Body(now, 80m);
        first["armRightCm"] = 33m;
        first["armLeftCm"] = 32m;
        using (await app.PutEntryAsync(login, id, first))
        {
        }

        var older = Body(now.AddSeconds(-30), 80m);
        older["armRightCm"] = 99m;
        using (await app.PutEntryAsync(login, id, older))
        {
        }

        var edit = Body(now.AddMinutes(1), 80m);
        edit["armRightCm"] = 34m;
        using var edited = await app.PutEntryAsync(login, id, edit);
        var json = await TrainingApp.JsonAsync(edited);

        json.GetProperty("armRightCm").GetDecimal().Should().Be(34m, "o último a escrever vence");
        json.GetProperty("armLeftCm").ValueKind.Should().Be(JsonValueKind.Null, "o PUT leva a medição inteira: o lado omitido é limpo");
    }

    [Fact]
    public async Task Tombstone_EmptiesTheNewValuesToo()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        var live = Body(now, 80m);
        live["chestCm"] = 95m;
        live["calfLeftCm"] = 38m;
        live["abdomenSkinfoldMm"] = 15m;
        using (await app.PutEntryAsync(login, id, live))
        {
        }

        var removed = Body(now.AddMinutes(1), 80m);
        removed["chestCm"] = 95m;
        removed["calfLeftCm"] = 38m;
        removed["abdomenSkinfoldMm"] = 15m;
        removed["deleted"] = true;
        using var response = await app.PutEntryAsync(login, id, removed);
        var json = await TrainingApp.JsonAsync(response);

        json.GetProperty("deleted").GetBoolean().Should().BeTrue();
        foreach (var field in new[] { "chestCm", "calfLeftCm", "abdomenSkinfoldMm" })
        {
            json.GetProperty(field).ValueKind.Should().Be(JsonValueKind.Null, $"{field}: a lápide não guarda dado de saúde");
        }

        await using var db = app.Db();
        var row = await db.Set<BodyEntry>().SingleAsync(Ct);
        row.ChestCm.Should().BeNull();
        row.CalfLeftCm.Should().BeNull();
        row.AbdomenSkinfoldMm.Should().BeNull();
    }

    [Theory]
    [InlineData("chestCm", 9.9)]
    [InlineData("abdomenCm", 250.1)]
    [InlineData("forearmCm", 0)]
    [InlineData("calfCm", -3)]
    [InlineData("armRightCm", 9.9)]
    [InlineData("armLeftCm", 250.1)]
    [InlineData("forearmRightCm", 33.25)]
    [InlineData("forearmLeftCm", 8)]
    [InlineData("thighRightCm", 251)]
    [InlineData("thighLeftCm", 58.55)]
    [InlineData("calfRightCm", 5)]
    [InlineData("calfLeftCm", 300)]
    [InlineData("chestSkinfoldMm", 0.9)]
    [InlineData("abdomenSkinfoldMm", 100.1)]
    [InlineData("thighSkinfoldMm", 12.25)]
    public async Task ANewValueOutsideTheLimits_OrWithTooManyDecimals_Returns400_AndNamesTheField(string field, double value)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var body = Body(DateTimeOffset.UtcNow, 80m);
        body[field] = (decimal)value;

        using var response = await app.PutEntryAsync(login, Guid.CreateVersion7(), body);
        var text = await response.Content.ReadAsStringAsync(Ct);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var json = JsonDocument.Parse(text);
        json.RootElement.GetProperty("errors").TryGetProperty(field, out _).Should().BeTrue();
    }

    [Fact]
    public async Task TheNewLimitsThemselves_AreAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var edges = new (string Field, decimal Value)[]
        {
            ("chestCm", 10m), ("abdomenCm", 250m), ("calfRightCm", 10m), ("thighLeftCm", 250m),
            ("chestSkinfoldMm", 1m), ("thighSkinfoldMm", 100m),
        };
        foreach (var (field, value) in edges)
        {
            var body = Body(DateTimeOffset.UtcNow);
            body[field] = value;

            using var response = await app.PutEntryAsync(login, Guid.CreateVersion7(), body);

            response.StatusCode.Should().Be(HttpStatusCode.OK, $"{field} = {value}");
        }
    }

    [Fact]
    public async Task ThePull_CarriesTheNewValues_AndAnotherUsersRowStaysOut()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var mine = Body(DateTimeOffset.UtcNow);
        mine["thighRightCm"] = 58.5m;
        mine["chestSkinfoldMm"] = 9m;
        using (await app.PutEntryAsync(owner, Guid.CreateVersion7(), mine))
        {
        }

        var foreign = NewEntry(Guid.NewGuid(), 70m);
        foreign.ThighRightCm = 99m;
        await using (var db = app.Db())
        {
            db.Add(foreign);
            await db.SaveChangesAsync(Ct);
        }

        var pulled = (await app.PullAllAsync(owner, "body/entries", limit: 50)).Rows().ToList();

        pulled.Should().ContainSingle("a linha de outra pessoa nunca aparece");
        pulled[0].GetProperty("thighRightCm").GetDecimal().Should().Be(58.5m);
        pulled[0].GetProperty("chestSkinfoldMm").GetDecimal().Should().Be(9m);
        pulled[0].GetProperty("thighLeftCm").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task AddBodyMeasurements_KeepsTheExistingRows_AndTheNewColumnsStartEmpty()
    {
        var database = await postgres.CreateDatabaseAsync();
        var user = Guid.NewGuid();
        await using (var training = TrainingApp.CreateContext(database.OwnerConnection))
        {
            await training.Database.MigrateAsync(PreviousMigration, Ct);
        }

        await using (var raw = new NpgsqlConnection(database.OwnerConnection))
        {
            await raw.OpenAsync(Ct);
            // Uma medição que já existe quando a migration nova roda em produção: só os campos antigos.
            await using var insert = new NpgsqlCommand(
                """
                INSERT INTO training.body_entries (id, user_id, measured_on, weight_kg, arm_cm, created_at, updated_at, client_updated_at)
                VALUES (@id, @user, CURRENT_DATE, 80.0, 34.0, now(), now(), now())
                """, raw);
            insert.Parameters.AddWithValue("id", Guid.CreateVersion7());
            insert.Parameters.AddWithValue("user", user);
            await insert.ExecuteNonQueryAsync(Ct);
        }

        await using (var training = TrainingApp.CreateContext(database.OwnerConnection))
        {
            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().ContainSingle().Which.Should().EndWith("_AddBodyMeasurements");
            await training.Database.MigrateAsync(Ct);
        }

        NpgsqlConnection.ClearAllPools();
        await using var after = TrainingApp.CreateContext(database.OwnerConnection);
        var row = await after.Set<BodyEntry>().SingleAsync(e => e.UserId == user, Ct);
        row.WeightKg.Should().Be(80m);
        row.ArmCm.Should().Be(34m, "o campo sem lado segue como estava");
        row.ChestCm.Should().BeNull();
        row.ArmRightCm.Should().BeNull();
        row.ThighSkinfoldMm.Should().BeNull();
    }

    [Fact]
    public async Task TheNewConstraints_RefuseValuesOutsideTheLimits_AndTheEmptyShapeKeepsFollowingTheNewColumns()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using (var training = TrainingApp.CreateContext(database.OwnerConnection))
        {
            await training.Database.MigrateAsync(Ct);
        }

        NpgsqlConnection.ClearAllPools();

        async Task<string?> TryAsync(Action<BodyEntry> shape)
        {
            await using var db = TrainingApp.CreateContext(database.OwnerConnection);
            var entry = NewEntry(Guid.NewGuid());
            shape(entry);
            db.Set<BodyEntry>().Add(entry);
            try
            {
                await db.SaveChangesAsync(Ct);
                return null;
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException pg)
            {
                return pg.ConstraintName ?? pg.SqlState;
            }
        }

        (await TryAsync(e => e.ChestCm = 9.9m)).Should().Be("ck_body_entries_chest");
        (await TryAsync(e => e.AbdomenCm = 250.1m)).Should().Be("ck_body_entries_abdomen");
        (await TryAsync(e => e.ForearmCm = 0m)).Should().Be("ck_body_entries_forearm");
        (await TryAsync(e => e.CalfCm = 251m)).Should().Be("ck_body_entries_calf");
        (await TryAsync(e => e.ArmRightCm = 9m)).Should().Be("ck_body_entries_arm_right");
        (await TryAsync(e => e.ArmLeftCm = 251m)).Should().Be("ck_body_entries_arm_left");
        (await TryAsync(e => e.ForearmRightCm = 9m)).Should().Be("ck_body_entries_forearm_right");
        (await TryAsync(e => e.ForearmLeftCm = 251m)).Should().Be("ck_body_entries_forearm_left");
        (await TryAsync(e => e.ThighRightCm = 9m)).Should().Be("ck_body_entries_thigh_right");
        (await TryAsync(e => e.ThighLeftCm = 251m)).Should().Be("ck_body_entries_thigh_left");
        (await TryAsync(e => e.CalfRightCm = 9m)).Should().Be("ck_body_entries_calf_right");
        (await TryAsync(e => e.CalfLeftCm = 251m)).Should().Be("ck_body_entries_calf_left");
        (await TryAsync(e => e.ChestSkinfoldMm = 0.9m)).Should().Be("ck_body_entries_chest_skinfold");
        (await TryAsync(e => e.AbdomenSkinfoldMm = 100.1m)).Should().Be("ck_body_entries_abdomen_skinfold");
        (await TryAsync(e => e.ThighSkinfoldMm = 0m)).Should().Be("ck_body_entries_thigh_skinfold");

        (await TryAsync(e => { e.WeightKg = null; e.ChestCm = 90m; })).Should().BeNull("a medida nova sozinha conta como valor");
        (await TryAsync(e => { e.WeightKg = null; e.CalfLeftCm = 38m; })).Should().BeNull();
        (await TryAsync(e => { e.WeightKg = null; e.ThighSkinfoldMm = 12m; })).Should().BeNull();
        (await TryAsync(e => { e.WeightKg = null; e.Note = "só anotação"; })).Should().Be("ck_body_entries_not_empty");
    }
}
