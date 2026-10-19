using AwesomeAssertions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;

namespace UniOver.IntegrationTests.Training;

[Collection(PostgresGroup.Name)]
public sealed class TrainingPersistenceTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<TestDatabase> MigratedAsync()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using (var training = TrainingApp.CreateContext(database.OwnerConnection))
        {
            await training.Database.MigrateAsync(Ct);
        }

        NpgsqlConnection.ClearAllPools();
        return database;
    }

    [Fact]
    public async Task Migration_AppliesOnAnEmptyPostgres_AndKeepsEverythingInTheTrainingSchema()
    {
        var database = await MigratedAsync();

        var tables = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'training' ORDER BY 1", Ct);
        var inPublic = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.PublicObjects, Ct);

        tables.Should().Equal(
            "__ef_migrations_history", "catalog_meta", "exercise_overrides", "exercises", "idempotency_keys", "routine_items", "routines");
        inPublic.Should().BeEmpty();
    }

    [Fact]
    public async Task Migration_LeavesNoForeignKeyOutsideTheTrainingSchema()
    {
        var database = await MigratedAsync();

        var crossing = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.CrossSchemaForeignKeys, Ct);
        var inside = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection,
            """
            SELECT cl.relname || ' -> ' || fl.relname
            FROM pg_constraint c
            JOIN pg_class cl ON cl.oid = c.conrelid
            JOIN pg_class fl ON fl.oid = c.confrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE c.contype = 'f' AND n.nspname = 'training'
            ORDER BY 1
            """, Ct);

        crossing.Should().BeEmpty("o usuário é de outro módulo e entra só como UUID");
        inside.Should().Equal("exercise_overrides -> exercises", "routine_items -> exercises", "routine_items -> routines");
    }

    [Fact]
    public async Task RuntimeRole_DoesDmlOnTheTables_ButNeverDdl_AndNeverTouchesTheMigrationHistory()
    {
        var database = await MigratedAsync();
        await using var connection = new NpgsqlConnection(database.RuntimeConnection);
        await connection.OpenAsync(Ct);

        await using (var insert = new NpgsqlCommand(
            "INSERT INTO training.catalog_meta (id, seed_version, seeded_at) VALUES (1, 1, now())", connection))
        {
            (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        foreach (var forbidden in new[]
        {
            "CREATE TABLE training.intruder (id int)",
            "ALTER TABLE training.exercises ADD COLUMN intruder int",
            "DROP TABLE training.catalog_meta",
            "SELECT count(*) FROM training.__ef_migrations_history",
            "DELETE FROM training.__ef_migrations_history",
        })
        {
            await using var command = new NpgsqlCommand(forbidden, connection);
            var act = () => command.ExecuteNonQueryAsync(Ct);

            (await act.Should().ThrowAsync<PostgresException>(forbidden)).Which.SqlState.Should().Be("42501", forbidden);
        }
    }

    [Fact]
    public async Task Constraints_RefuseTheSameSourceRefTwice_TheSameSlugTwice_AndUnknownSources()
    {
        var database = await MigratedAsync();
        var now = DateTimeOffset.UtcNow;

        Exercise Row(string slug, string source, string? sourceRef) => new()
        {
            Id = Guid.CreateVersion7(), Slug = slug, Source = source, SourceRef = sourceRef, Name = slug, Equipment = Equipment.Other,
            PrimaryMuscles = [Muscle.Chest], CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
        };

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            db.Exercises.Add(Row("a", ExerciseSources.FreeExerciseDb, "ref-1"));
            await db.SaveChangesAsync(Ct);
        }

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            db.Exercises.Add(Row("b", ExerciseSources.FreeExerciseDb, "ref-1"));
            var act = () => db.SaveChangesAsync(Ct);
            (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
                .Which.SqlState.Should().Be("23505");
        }

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            db.Exercises.Add(Row("a", ExerciseSources.FreeExerciseDb, "ref-2"));
            var act = () => db.SaveChangesAsync(Ct);
            (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
                .Which.SqlState.Should().Be("23505");
        }

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            // O mesmo slug em outra fonte é permitido; vários exercícios próprios sem origem também.
            db.Exercises.Add(Row("a", ExerciseSources.Wger, "ref-1"));
            db.Exercises.Add(Row("own-1", ExerciseSources.Own, null));
            db.Exercises.Add(Row("own-2", ExerciseSources.Own, null));
            await db.SaveChangesAsync(Ct);
        }

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            db.Exercises.Add(Row("c", "mystery", null));
            var act = () => db.SaveChangesAsync(Ct);
            (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
                .Which.SqlState.Should().Be("23514");
        }
    }

    [Fact]
    public async Task CatalogMeta_AcceptsASingleRowOnly()
    {
        var database = await MigratedAsync();
        await using var db = TrainingApp.CreateContext(database.OwnerConnection);
        db.CatalogMeta.Add(new CatalogMeta { Id = 2, SeedVersion = 1, SeededAt = DateTimeOffset.UtcNow });

        var act = () => db.SaveChangesAsync(Ct);

        (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
            .Which.SqlState.Should().Be("23514");
    }

    [Fact]
    public async Task TheModuleAddsNoPublicRoute_AndEveryTrainingRouteDemandsAuthorization()
    {
        PublicRoutes.All.Should().NotContain(r => r.Pattern.Contains("/training", StringComparison.Ordinal));

        await using var factory = await GuardHost.StartAsync(postgres, "Production");
        var routes = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(r => (r.RoutePattern.RawText ?? string.Empty).StartsWith("/api/v1/training", StringComparison.Ordinal))
            .ToList();

        routes.Should().HaveCountGreaterThanOrEqualTo(5);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<IAuthorizeData>() != null);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<IAllowAnonymous>() == null);
        routes.Select(r => r.RoutePattern.RawText).Should().Contain(
        [
            "/api/v1/training/exercises",
            "/api/v1/training/exercises/{id:guid}",
            "/api/v1/training/exercises/{id:guid}/step",
            "/api/v1/training/catalog/credits",
            "/api/v1/training/catalog/imports/wger",
        ]);
    }

    [Fact]
    public async Task TheModuleHasNoDeleteEndpoint()
    {
        await using var factory = await GuardHost.StartAsync(postgres, "Production");

        var methods = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(r => (r.RoutePattern.RawText ?? string.Empty).StartsWith("/api/v1/training", StringComparison.Ordinal))
            .SelectMany(r => r.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? []);

        methods.Should().NotContain("DELETE", "apagar é um PUT com lápide");
    }
}
