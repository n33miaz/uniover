using AwesomeAssertions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain.Body;
using UniOver.Modules.Training.Domain.Goals;
using static UniOver.IntegrationTests.Training.BodyMetrics.BodyHelpers;
using static UniOver.IntegrationTests.Training.Goals.GoalHelpers;

namespace UniOver.IntegrationTests.Training.BodyMetrics;

[Collection(PostgresGroup.Name)]
public sealed class BodyPersistenceTests(PostgresFixture postgres)
{
    private const string PreviousMigration = "20261019220109_AddGoals";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<TestDatabase> MigratedAsync(string? upTo = null)
    {
        var database = await postgres.CreateDatabaseAsync();
        await using (var training = TrainingApp.CreateContext(database.OwnerConnection))
        {
            if (upTo is null)
            {
                await training.Database.MigrateAsync(Ct);
            }
            else
            {
                await training.Database.MigrateAsync(upTo, Ct);
            }
        }

        NpgsqlConnection.ClearAllPools();
        return database;
    }

    [Fact]
    public async Task AddBody_AppliesOnTopOfTheEarlierMigrations_AndKeepsTheExistingTablesAndTheirRows()
    {
        var database = await MigratedAsync(PreviousMigration);
        var user = Guid.NewGuid();
        await using (var before = TrainingApp.CreateContext(database.OwnerConnection))
        {
            // Dado que já existe quando a migration nova roda em produção: ela só acrescenta tabelas, não toca no que há.
            before.Add(NewGoal(user, GoalKinds.WeeklySessions));
            await before.SaveChangesAsync(Ct);
        }

        await using (var training = TrainingApp.CreateContext(database.OwnerConnection))
        {
            (await training.Database.GetPendingMigrationsAsync(Ct)).First().Should().EndWith("_AddBody");
            await training.Database.MigrateAsync(Ct);
        }

        var tables = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'training' ORDER BY 1", Ct);
        var inPublic = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.PublicObjects, Ct);

        tables.Should().Contain(["body_entries", "body_profile", "goals", "sessions", "session_sets", "routines", "exercises"]);
        inPublic.Should().BeEmpty();
        await using var after = TrainingApp.CreateContext(database.OwnerConnection);
        (await after.Set<Goal>().CountAsync(g => g.UserId == user, Ct)).Should().Be(1, "a linha que já existia segue lá");
    }

    [Fact]
    public async Task TheBodyTables_HaveNoForeignKey_NotEvenInsideTheSchema_AndNoneCrossesToAnotherModule()
    {
        var database = await MigratedAsync();

        var crossing = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.CrossSchemaForeignKeys, Ct);
        var fromBody = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection,
            """
            SELECT cl.relname || ' -> ' || fl.relname
            FROM pg_constraint c
            JOIN pg_class cl ON cl.oid = c.conrelid
            JOIN pg_class fl ON fl.oid = c.confrelid
            WHERE c.contype = 'f' AND cl.relname IN ('body_entries', 'body_profile')
            """, Ct);

        crossing.Should().BeEmpty("o usuário é de outro módulo e entra só como UUID");
        fromBody.Should().BeEmpty("o corpo só guarda o id do usuário");
    }

    [Fact]
    public async Task EntryConstraints_RefuseValuesOutsideTheLimits_AndTheWrongShape()
    {
        var database = await MigratedAsync();

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

        (await TryAsync(_ => { })).Should().BeNull("o caso válido grava");
        (await TryAsync(e => e.WeightKg = 19.99m)).Should().Be("ck_body_entries_weight");
        (await TryAsync(e => e.WeightKg = 400.01m)).Should().Be("ck_body_entries_weight");
        (await TryAsync(e => { e.WeightKg = null; e.BodyFatPct = 1.9m; e.FatMethod = "manual"; })).Should().Be("ck_body_entries_body_fat");
        (await TryAsync(e => { e.BodyFatPct = 70.1m; e.FatMethod = "manual"; })).Should().Be("ck_body_entries_body_fat");
        (await TryAsync(e => { e.BodyFatPct = 20m; e.FatMethod = "manual"; })).Should().BeNull();
        (await TryAsync(e => e.WaistCm = 9.9m)).Should().Be("ck_body_entries_waist");
        (await TryAsync(e => e.NeckCm = 250.1m)).Should().Be("ck_body_entries_neck");
        (await TryAsync(e => e.HipCm = 0m)).Should().Be("ck_body_entries_hip");
        (await TryAsync(e => e.ArmCm = -1m)).Should().Be("ck_body_entries_arm");
        (await TryAsync(e => e.ThighCm = 251m)).Should().Be("ck_body_entries_thigh");
        (await TryAsync(e => e.Note = new string('a', 300))).Should().BeNull();
        (await TryAsync(e => e.Note = new string('a', 301))).Should().Be("22001", "o varchar(300) recusa o 301.º caractere; o check repete o mesmo teto");
        (await TryAsync(e => e.MeasuredOn = new DateOnly(1899, 12, 31))).Should().Be("ck_body_entries_measured_on");
        (await TryAsync(e => { e.BodyFatPct = 20m; e.FatMethod = null; })).Should().Be("ck_body_entries_fat_pair", "gordura sem método não se grava");
        (await TryAsync(e => e.FatMethod = "manual")).Should().Be("ck_body_entries_fat_pair", "método sem gordura não se grava");
        (await TryAsync(e => { e.BodyFatPct = 20m; e.FatMethod = "dobras"; })).Should().Be("ck_body_entries_fat_method");
        (await TryAsync(e => e.WeightKg = null)).Should().Be("ck_body_entries_not_empty", "a medição viva precisa de um valor");
        (await TryAsync(e => { e.WeightKg = null; e.Note = "só anotação"; })).Should().Be("ck_body_entries_not_empty");
        (await TryAsync(e => { e.WeightKg = null; e.DeletedAt = DateTimeOffset.UtcNow; })).Should().BeNull("só a lápide pode estar vazia");
    }

    [Fact]
    public async Task ProfileConstraints_RefuseValuesOutsideTheLimits_AndOnlyOneRowPerUser()
    {
        var database = await MigratedAsync();

        async Task<string?> TryAsync(Action<BodyProfile> shape, Guid? user = null)
        {
            await using var db = TrainingApp.CreateContext(database.OwnerConnection);
            var profile = NewProfile(user ?? Guid.NewGuid());
            shape(profile);
            db.Set<BodyProfile>().Add(profile);
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

        (await TryAsync(_ => { })).Should().BeNull();
        (await TryAsync(p => p.HeightCm = 99.9m)).Should().Be("ck_body_profile_height");
        (await TryAsync(p => p.HeightCm = 250.1m)).Should().Be("ck_body_profile_height");
        (await TryAsync(p => p.BirthDate = new DateOnly(1899, 12, 31))).Should().Be("ck_body_profile_birth_date");
        (await TryAsync(p => p.Sex = "outro")).Should().Be("ck_body_profile_sex");
        (await TryAsync(p => p.ActivityFactor = 0.99m)).Should().Be("ck_body_profile_activity");
        (await TryAsync(p => p.ActivityFactor = 2.51m)).Should().Be("ck_body_profile_activity");

        var user = Guid.NewGuid();
        (await TryAsync(_ => { }, user)).Should().BeNull();
        (await TryAsync(_ => { }, user)).Should().Be("pk_body_profile", "a chave natural é o usuário: um perfil só");
    }

    [Fact]
    public async Task RuntimeRole_DoesDmlOnTheBodyTables_ButNeverDdl()
    {
        var database = await MigratedAsync();
        await using var connection = new NpgsqlConnection(database.RuntimeConnection);
        await connection.OpenAsync(Ct);

        await using (var insert = new NpgsqlCommand(
            "INSERT INTO training.body_entries (id, user_id, measured_on, weight_kg, created_at, updated_at, client_updated_at) " +
            "VALUES (gen_random_uuid(), gen_random_uuid(), current_date, 80, now(), now(), now())", connection))
        {
            (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        await using (var insertProfile = new NpgsqlCommand(
            "INSERT INTO training.body_profile (user_id, height_cm, birth_date, sex, activity_factor, created_at, updated_at, client_updated_at) " +
            "VALUES (gen_random_uuid(), 180, DATE '1990-01-01', 'male', 1.55, now(), now(), now())", connection))
        {
            (await insertProfile.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        await using (var update = new NpgsqlCommand("UPDATE training.body_entries SET weight_kg = 81", connection))
        {
            (await update.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        foreach (var forbidden in new[]
        {
            "CREATE TABLE training.intruder (id int)",
            "ALTER TABLE training.body_entries ADD COLUMN intruder int",
            "DROP TABLE training.body_profile",
            "TRUNCATE training.body_entries",
        })
        {
            await using var command = new NpgsqlCommand(forbidden, connection);
            var act = () => command.ExecuteNonQueryAsync(Ct);

            var failure = await act.Should().ThrowAsync<PostgresException>(forbidden);
            failure.Which.SqlState.Should().BeOneOf(["42501"], forbidden);
        }
    }

    [Fact]
    public async Task TheBodyRoutes_DemandAuthorization_AreNotPublic_AndOnlyWrite_ByPut()
    {
        await using var factory = await GuardHost.StartAsync(postgres, "Production");
        var routes = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(r => (r.RoutePattern.RawText ?? string.Empty).StartsWith("/api/v1/training/body", StringComparison.Ordinal))
            .ToList();

        routes.Select(r => r.RoutePattern.RawText).Should().BeEquivalentTo(
        [
            "/api/v1/training/body/entries",
            "/api/v1/training/body/entries/{id:guid}",
            "/api/v1/training/body/profile",
            "/api/v1/training/body/profile",
        ]);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<IAuthorizeData>() != null);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<IAllowAnonymous>() == null);
        routes.SelectMany(r => r.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? []).Should().BeEquivalentTo(["GET", "PUT", "GET", "PUT"]);
        PublicRoutes.All.Should().NotContain(r => r.Pattern.Contains("/body", StringComparison.Ordinal));
    }
}
