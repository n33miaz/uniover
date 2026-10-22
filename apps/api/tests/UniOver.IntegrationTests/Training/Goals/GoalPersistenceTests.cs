using AwesomeAssertions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Goals;
using UniOver.Modules.Training.Persistence;
using static UniOver.IntegrationTests.Training.Goals.GoalHelpers;

namespace UniOver.IntegrationTests.Training.Goals;

[Collection(PostgresGroup.Name)]
public sealed class GoalPersistenceTests(PostgresFixture postgres)
{
    private const string PreviousMigration = "20261019204546_AddSessions";

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
            Id = id, Slug = "x-" + id.ToString("N")[..8], Source = UniOver.Modules.Training.Contracts.ExerciseSources.Own, Name = "Exercício",
            OwnerUserId = Guid.NewGuid(), Equipment = Equipment.Other, PrimaryMuscles = [Muscle.Chest], CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
        });
        await db.SaveChangesAsync(Ct);
        return id;
    }

    [Fact]
    public async Task AddGoals_AppliesOnTopOfTheEarlierMigrations_AndKeepsEverythingInTheTrainingSchema()
    {
        var database = await MigratedAsync(PreviousMigration);

        await using (var training = TrainingApp.CreateContext(database.OwnerConnection))
        {
            (await training.Database.GetPendingMigrationsAsync(Ct)).First().Should().EndWith("_AddGoals");
            await training.Database.MigrateAsync(Ct);
        }

        var tables = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'training' ORDER BY 1", Ct);
        var inPublic = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.PublicObjects, Ct);

        tables.Should().Contain(["goals", "sessions", "routines", "exercises"]);
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
            WHERE c.contype = 'f' AND n.nspname = 'training' AND cl.relname = 'goals'
            ORDER BY 1
            """, Ct);

        crossing.Should().BeEmpty("o usuário é de outro módulo e entra só como UUID");
        inside.Should().Equal("goals -> exercises");
    }

    [Fact]
    public async Task TheNaturalKeyIndex_TreatsNullsAsEqual_SoGoalsWithoutAnExerciseCannotRepeat()
    {
        var database = await MigratedAsync();

        var definition = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection,
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'training' AND tablename = 'goals' AND indexname = 'ix_goals_user_id_kind_exercise_id'", Ct);

        definition.Should().ContainSingle().Which.Should().Contain("UNIQUE").And.Contain("NULLS NOT DISTINCT");
    }

    [Fact]
    public async Task TheNaturalKey_IsUniquePerUser_EvenWithoutAnExercise_AndEvenForATombstone()
    {
        var database = await MigratedAsync();
        var user = Guid.NewGuid();
        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            db.AddRange(
                NewGoal(user, GoalKinds.WeeklySessions),
                NewGoal(user, GoalKinds.DailyKcal, value: 2200m),
                NewGoal(Guid.NewGuid(), GoalKinds.WeeklySessions));
            await db.SaveChangesAsync(Ct);
        }

        await using var again = TrainingApp.CreateContext(database.OwnerConnection);
        again.Add(NewGoal(user, GoalKinds.WeeklySessions, deleted: true));
        var act = () => again.SaveChangesAsync(Ct);

        (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
            .Which.SqlState.Should().Be("23505");
    }

    [Fact]
    public async Task Constraints_RefuseValuesOutsideTheLimits_AndTheWrongShapeOfTheKey()
    {
        var database = await MigratedAsync();
        Guid exercise;
        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            exercise = await SeedExerciseAsync(db);
        }

        async Task<string?> TryAsync(Action<Goal> shape)
        {
            await using var db = TrainingApp.CreateContext(database.OwnerConnection);
            var goal = NewGoal(Guid.NewGuid());
            shape(goal);
            db.Set<Goal>().Add(goal);
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

        (await TryAsync(_ => { })).Should().BeNull("o caso válido grava");
        (await TryAsync(g => g.Kind = "weight")).Should().Be("ck_goals_kind");
        (await TryAsync(g => g.Value = 0m)).Should().Be("ck_goals_value");
        (await TryAsync(g => g.Value = 15m)).Should().Be("ck_goals_value");
        (await TryAsync(g => g.Value = null)).Should().Be("ck_goals_value", "sem valor só a lápide");
        (await TryAsync(g => { g.Kind = GoalKinds.DailyKcal; g.Value = 499m; })).Should().Be("ck_goals_value");
        (await TryAsync(g => { g.Kind = GoalKinds.DailyKcal; g.Value = 10001m; })).Should().Be("ck_goals_value");
        (await TryAsync(g => { g.Kind = GoalKinds.ExerciseE1rm; g.ExerciseId = exercise; g.Value = 1001m; })).Should().Be("ck_goals_value");
        (await TryAsync(g => { g.Kind = GoalKinds.ExerciseE1rm; g.ExerciseId = exercise; g.Value = 55m; })).Should().BeNull();
        (await TryAsync(g => g.Kind = GoalKinds.ExerciseE1rm)).Should().Be("ck_goals_exercise", "o exercício é obrigatório na meta de 1RM");
        (await TryAsync(g => g.ExerciseId = exercise)).Should().Be("ck_goals_exercise", "as outras metas não têm exercício");
        (await TryAsync(g => { g.Kind = GoalKinds.ExerciseE1rm; g.ExerciseId = Guid.NewGuid(); })).Should().Be("fk_goals_exercises_exercise_id");
    }

    [Fact]
    public async Task RuntimeRole_DoesDmlOnTheGoalsTable_ButNeverDdl()
    {
        var database = await MigratedAsync();
        await using var connection = new NpgsqlConnection(database.RuntimeConnection);
        await connection.OpenAsync(Ct);

        await using (var insert = new NpgsqlCommand(
            "INSERT INTO training.goals (id, user_id, kind, value, created_at, updated_at, client_updated_at) " +
            "VALUES (gen_random_uuid(), gen_random_uuid(), 'weekly_sessions', 3, now(), now(), now())", connection))
        {
            (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        await using (var update = new NpgsqlCommand("UPDATE training.goals SET value = 4", connection))
        {
            (await update.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        foreach (var forbidden in new[]
        {
            "CREATE TABLE training.intruder (id int)",
            "ALTER TABLE training.goals ADD COLUMN intruder int",
            "DROP TABLE training.goals",
            "TRUNCATE training.goals",
        })
        {
            await using var command = new NpgsqlCommand(forbidden, connection);
            var act = () => command.ExecuteNonQueryAsync(Ct);

            var failure = await act.Should().ThrowAsync<PostgresException>(forbidden);
            failure.Which.SqlState.Should().BeOneOf(["42501"], forbidden);
        }
    }

    [Fact]
    public async Task ExerciseInUse_CannotBeDeleted_BecauseTheGoalHoldsIt()
    {
        var database = await MigratedAsync();
        Guid exercise;
        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            exercise = await SeedExerciseAsync(db);
            db.Add(NewGoal(Guid.NewGuid(), GoalKinds.ExerciseE1rm, exercise, 55m));
            await db.SaveChangesAsync(Ct);
        }

        await using var again = TrainingApp.CreateContext(database.OwnerConnection);
        var act = () => again.Exercises.Where(e => e.Id == exercise).ExecuteDeleteAsync(Ct);

        (await act.Should().ThrowAsync<PostgresException>()).Which.SqlState.Should().Be("23001");
    }

    [Fact]
    public async Task TheGoalRoutes_DemandAuthorization_AreNotPublic_AndOnlyWrite_ByPut()
    {
        await using var factory = await GuardHost.StartAsync(postgres, "Production");
        var routes = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(r => (r.RoutePattern.RawText ?? string.Empty).StartsWith("/api/v1/training/goals", StringComparison.Ordinal))
            .ToList();

        routes.Select(r => r.RoutePattern.RawText).Should().BeEquivalentTo(["/api/v1/training/goals", "/api/v1/training/goals/{kind}"]);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<IAuthorizeData>() != null);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<IAllowAnonymous>() == null);
        routes.SelectMany(r => r.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? []).Should().BeEquivalentTo(["GET", "PUT"]);
        PublicRoutes.All.Should().NotContain(r => r.Pattern.Contains("/goals", StringComparison.Ordinal));
    }
}
