using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Persistence;

namespace UniOver.IntegrationTests.Training.Routines;

[Collection(PostgresGroup.Name)]
public sealed class RoutinePersistenceTests(PostgresFixture postgres)
{
    private const string InitialMigration = "20261019160210_InitialCreate";

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

    private static async Task<Guid> SeedExerciseAsync(TrainingDbContext db)
    {
        var now = DateTimeOffset.UtcNow;
        var id = Guid.CreateVersion7();
        db.Exercises.Add(new Exercise
        {
            Id = id, Slug = "x-" + id.ToString("N")[..8], Source = ExerciseSources.Own, Name = "Exercício", OwnerUserId = Guid.NewGuid(),
            Equipment = Equipment.Other, PrimaryMuscles = [Muscle.Chest], CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
        });
        await db.SaveChangesAsync(Ct);
        return id;
    }

    private static Routine NewRoutine(Guid? id = null) => new()
    {
        Id = id ?? Guid.CreateVersion7(), UserId = Guid.NewGuid(), Name = "A", Position = 0, Active = true,
        CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow, ClientUpdatedAt = DateTimeOffset.UtcNow,
    };

    private static RoutineItem NewItem(Guid routineId, Guid exerciseId) => new()
    {
        RoutineId = routineId, Id = Guid.CreateVersion7(), ExerciseId = exerciseId, Position = 0, TargetSets = 3, RepMin = 8, RepMax = 12, RestSeconds = 90,
    };

    [Fact]
    public async Task AddRoutines_AppliesOnTopOfInitialCreate_OnAnEmptyPostgres_AndKeepsEverythingInTheTrainingSchema()
    {
        var database = await MigratedAsync(InitialMigration);

        await using (var training = TrainingApp.CreateContext(database.OwnerConnection))
        {
            (await training.Database.GetAppliedMigrationsAsync(Ct)).Should().Equal(InitialMigration);
            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().HaveCount(3).And.Subject.First().Should().EndWith("_AddRoutines");
            await training.Database.MigrateAsync(Ct);
        }

        var tables = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'training' ORDER BY 1", Ct);
        var inPublic = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.PublicObjects, Ct);

        tables.Should().Contain(["routines", "routine_items", "exercises", "catalog_meta"]);
        inPublic.Should().BeEmpty();
    }

    [Fact]
    public async Task ForeignKeys_StayInsideTheSchema_AndNoneCrossesToAnotherModule()
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
            WHERE c.contype = 'f' AND n.nspname = 'training' AND cl.relname LIKE 'routine%'
            ORDER BY 1
            """, Ct);

        crossing.Should().BeEmpty("o usuário é de outro módulo e entra só como UUID");
        inside.Should().Equal("routine_items -> exercises", "routine_items -> routines");
    }

    [Fact]
    public async Task RuntimeRole_DoesDmlOnTheRoutineTables_ButNeverDdl()
    {
        var database = await MigratedAsync();
        await using var connection = new NpgsqlConnection(database.RuntimeConnection);
        await connection.OpenAsync(Ct);

        await using (var insert = new NpgsqlCommand(
            "INSERT INTO training.routines (id, user_id, name, position, active, created_at, updated_at, client_updated_at) " +
            "VALUES (gen_random_uuid(), gen_random_uuid(), 'A', 0, true, now(), now(), now())", connection))
        {
            (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        await using (var select = new NpgsqlCommand("SELECT count(*) FROM training.routine_items", connection))
        {
            (await select.ExecuteScalarAsync(Ct)).Should().Be(0L);
        }

        foreach (var forbidden in new[]
        {
            "CREATE TABLE training.intruder (id int)",
            "ALTER TABLE training.routines ADD COLUMN intruder int",
            "DROP TABLE training.routine_items",
            "TRUNCATE training.routines CASCADE",
        })
        {
            await using var command = new NpgsqlCommand(forbidden, connection);
            var act = () => command.ExecuteNonQueryAsync(Ct);

            var failure = await act.Should().ThrowAsync<PostgresException>(forbidden);
            failure.Which.SqlState.Should().BeOneOf(["42501"], forbidden);
        }
    }

    [Fact]
    public async Task Constraints_RefuseValuesOutsideTheLimits()
    {
        var database = await MigratedAsync();
        Guid exercise;
        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            exercise = await SeedExerciseAsync(db);
        }

        async Task<string?> TryAsync(Action<Routine, RoutineItem> shape)
        {
            await using var db = TrainingApp.CreateContext(database.OwnerConnection);
            var routine = NewRoutine();
            var item = NewItem(routine.Id, exercise);
            shape(routine, item);
            routine.Items.Add(item);
            db.Set<Routine>().Add(routine);
            try
            {
                await db.SaveChangesAsync(Ct);
                return null;
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException pg)
            {
                return pg.ConstraintName;
            }
        }

        (await TryAsync((_, _) => { })).Should().BeNull("o caso válido grava");
        (await TryAsync((r, _) => r.Name = string.Empty)).Should().Be("ck_routines_name");
        (await TryAsync((r, _) => r.Position = -1)).Should().Be("ck_routines_position");
        (await TryAsync((_, i) => i.TargetSets = 0)).Should().Be("ck_routine_items_sets");
        (await TryAsync((_, i) => i.TargetSets = 21)).Should().Be("ck_routine_items_sets");
        (await TryAsync((_, i) => (i.RepMin, i.RepMax) = (12, 8))).Should().Be("ck_routine_items_reps");
        (await TryAsync((_, i) => i.RepMax = 101)).Should().Be("ck_routine_items_reps");
        (await TryAsync((_, i) => i.RestSeconds = 1801)).Should().Be("ck_routine_items_rest");
        (await TryAsync((_, i) => i.RestSeconds = -1)).Should().Be("ck_routine_items_rest");
        (await TryAsync((_, i) => i.SupersetGroup = 0)).Should().Be("ck_routine_items_superset");
        (await TryAsync((_, i) => i.Position = -1)).Should().Be("ck_routine_items_position");
    }

    [Fact]
    public async Task Item_WithAnUnknownExercise_IsRefusedByTheForeignKey()
    {
        var database = await MigratedAsync();
        await using var db = TrainingApp.CreateContext(database.OwnerConnection);
        var routine = NewRoutine();
        routine.Items.Add(NewItem(routine.Id, Guid.NewGuid()));
        db.Set<Routine>().Add(routine);

        var act = () => db.SaveChangesAsync(Ct);

        (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
            .Which.SqlState.Should().Be("23503");
    }

    [Fact]
    public async Task DeletingARoutineRow_RemovesItsItems_ButAnExerciseInUseCannotBeDeleted()
    {
        var database = await MigratedAsync();
        Guid exercise;
        var routine = NewRoutine();
        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            exercise = await SeedExerciseAsync(db);
            routine.Items.Add(NewItem(routine.Id, exercise));
            db.Set<Routine>().Add(routine);
            await db.SaveChangesAsync(Ct);
        }

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            var act = () => db.Exercises.Where(e => e.Id == exercise).ExecuteDeleteAsync(Ct);
            (await act.Should().ThrowAsync<PostgresException>()).Which.SqlState.Should().Be("23001", "o exercício em uso não some (restrict_violation)");
        }

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            await db.Set<Routine>().Where(r => r.Id == routine.Id).ExecuteDeleteAsync(Ct);
            (await db.Set<RoutineItem>().CountAsync(Ct)).Should().Be(0, "os itens morrem com a rotina");
        }
    }

    [Fact]
    public async Task TheSameItemIdIsAllowedInDifferentRoutines_ButNotTwiceInTheSameOne()
    {
        var database = await MigratedAsync();
        await using var db = TrainingApp.CreateContext(database.OwnerConnection);
        var exercise = await SeedExerciseAsync(db);
        var (first, second) = (NewRoutine(), NewRoutine());
        var shared = Guid.CreateVersion7();
        first.Items.Add(new RoutineItem { RoutineId = first.Id, Id = shared, ExerciseId = exercise, Position = 0, TargetSets = 3, RepMin = 8, RepMax = 12, RestSeconds = 60 });
        second.Items.Add(new RoutineItem { RoutineId = second.Id, Id = shared, ExerciseId = exercise, Position = 0, TargetSets = 3, RepMin = 8, RepMax = 12, RestSeconds = 60 });
        db.Set<Routine>().AddRange(first, second);
        await db.SaveChangesAsync(Ct);

        await using var again = TrainingApp.CreateContext(database.OwnerConnection);
        again.Set<RoutineItem>().Add(new RoutineItem { RoutineId = first.Id, Id = shared, ExerciseId = exercise, Position = 1, TargetSets = 3, RepMin = 8, RepMax = 12, RestSeconds = 60 });
        var act = () => again.SaveChangesAsync(Ct);

        (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
            .Which.SqlState.Should().Be("23505");
    }

    [Fact]
    public async Task TheModule_AddsRoutineRoutes_AllAuthorized_NoneAnonymous_AndNoDelete()
    {
        await using var factory = await GuardHost.StartAsync(postgres, "Production");
        var routes = factory.Services.GetRequiredService<Microsoft.AspNetCore.Routing.EndpointDataSource>().Endpoints
            .OfType<Microsoft.AspNetCore.Routing.RouteEndpoint>()
            .Where(r => (r.RoutePattern.RawText ?? string.Empty).StartsWith("/api/v1/training/routine", StringComparison.Ordinal))
            .ToList();

        routes.Select(r => r.RoutePattern.RawText).Should().BeEquivalentTo(
        [
            "/api/v1/training/routines",
            "/api/v1/training/routines/{id:guid}",
            "/api/v1/training/routine-templates",
        ]);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<Microsoft.AspNetCore.Authorization.IAuthorizeData>() != null);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<Microsoft.AspNetCore.Authorization.IAllowAnonymous>() == null);
        routes.SelectMany(r => r.Metadata.GetMetadata<Microsoft.AspNetCore.Routing.HttpMethodMetadata>()?.HttpMethods ?? [])
            .Should().NotContain("DELETE");
        PublicRoutes.All.Should().NotContain(r => r.Pattern.Contains("routine", StringComparison.Ordinal));
    }
}
