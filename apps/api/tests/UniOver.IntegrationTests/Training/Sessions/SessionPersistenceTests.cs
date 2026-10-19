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
using UniOver.Modules.Training.Domain.Sessions;
using UniOver.Modules.Training.Persistence;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.Sessions;

[Collection(PostgresGroup.Name)]
public sealed class SessionPersistenceTests(PostgresFixture postgres)
{
    private const string PreviousMigration = "20261019192036_AddRoutines";

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

    [Fact]
    public async Task AddSessions_AppliesOnTopOfTheEarlierMigrations_AndKeepsEverythingInTheTrainingSchema()
    {
        var database = await MigratedAsync(PreviousMigration);

        await using (var training = TrainingApp.CreateContext(database.OwnerConnection))
        {
            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().HaveCount(2).And.Subject.First().Should().EndWith("_AddSessions");
            await training.Database.MigrateAsync(Ct);
        }

        var tables = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'training' ORDER BY 1", Ct);
        var inPublic = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.PublicObjects, Ct);

        tables.Should().Contain(["sessions", "session_sets", "routines", "exercises"]);
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
            WHERE c.contype = 'f' AND n.nspname = 'training' AND cl.relname LIKE 'session%'
            ORDER BY 1
            """, Ct);

        crossing.Should().BeEmpty("o usuário é de outro módulo e entra só como UUID");
        inside.Should().Equal("session_sets -> exercises", "session_sets -> sessions", "sessions -> routines");
    }

    [Fact]
    public async Task RuntimeRole_DoesDmlOnTheSessionTables_ButNeverDdl()
    {
        var database = await MigratedAsync();
        await using var connection = new NpgsqlConnection(database.RuntimeConnection);
        await connection.OpenAsync(Ct);

        await using (var insert = new NpgsqlCommand(
            "INSERT INTO training.sessions (id, user_id, started_at, device_id, created_at, updated_at, client_updated_at) " +
            "VALUES (gen_random_uuid(), gen_random_uuid(), now(), 'a', now(), now(), now())", connection))
        {
            (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        await using (var select = new NpgsqlCommand("SELECT count(*) FROM training.session_sets", connection))
        {
            (await select.ExecuteScalarAsync(Ct)).Should().Be(0L);
        }

        await using (var update = new NpgsqlCommand("UPDATE training.sessions SET note = 'ok'", connection))
        {
            (await update.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        foreach (var forbidden in new[]
        {
            "CREATE TABLE training.intruder (id int)",
            "ALTER TABLE training.sessions ADD COLUMN intruder int",
            "DROP TABLE training.session_sets",
            "TRUNCATE training.sessions CASCADE",
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

        async Task<string?> TryAsync(Action<Session, SessionSet> shape)
        {
            await using var db = TrainingApp.CreateContext(database.OwnerConnection);
            var session = NewSession(Guid.NewGuid());
            var set = NewSet(session.UserId, session.Id, exercise);
            shape(session, set);
            db.Set<Session>().Add(session);
            db.Set<SessionSet>().Add(set);
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
        (await TryAsync((s, _) => s.Feeling = 0)).Should().Be("ck_sessions_feeling");
        (await TryAsync((s, _) => s.Feeling = 6)).Should().Be("ck_sessions_feeling");
        (await TryAsync((s, _) => s.DeviceId = string.Empty)).Should().Be("ck_sessions_device");
        (await TryAsync((s, _) => s.FinishedAt = s.StartedAt.AddMinutes(-1))).Should().Be("ck_sessions_finish");
        (await TryAsync((_, t) => t.SetType = "pyramid")).Should().Be("ck_session_sets_type");
        (await TryAsync((_, t) => t.WeightKg = -1m)).Should().Be("ck_session_sets_weight");
        (await TryAsync((_, t) => t.Reps = 1000)).Should().Be("ck_session_sets_reps");
        (await TryAsync((_, t) => t.Reps = -1)).Should().Be("ck_session_sets_reps");
        (await TryAsync((_, t) => t.Rir = 11)).Should().Be("ck_session_sets_rir");
        (await TryAsync((_, t) => t.Rpe = 7.25m)).Should().Be("ck_session_sets_rpe");
        (await TryAsync((_, t) => t.Rpe = 0.5m)).Should().Be("ck_session_sets_rpe");
        (await TryAsync((_, t) => t.Rpe = 7.5m)).Should().BeNull("meio ponto vale");
        (await TryAsync((_, t) => t.DurationS = 86401)).Should().Be("ck_session_sets_duration");
        (await TryAsync((_, t) => t.Position = -1)).Should().Be("ck_session_sets_position");
    }

    [Fact]
    public async Task TheDatabaseItself_RefusesASecondOpenSessionOfTheSameUser_ButNotOfAnotherUserNorAFinishedOne()
    {
        var database = await MigratedAsync();
        var user = Guid.NewGuid();
        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            db.AddRange(
                NewSession(user),
                NewSession(user, finishedAt: DateTimeOffset.UtcNow),
                NewSession(user, deletedAt: DateTimeOffset.UtcNow),
                NewSession(Guid.NewGuid()));
            await db.SaveChangesAsync(Ct);
        }

        await using var again = TrainingApp.CreateContext(database.OwnerConnection);
        again.Add(NewSession(user, device: "outro"));
        var act = () => again.SaveChangesAsync(Ct);

        (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
            .Which.SqlState.Should().Be("23505");
    }

    [Fact]
    public async Task Session_WithAnUnknownRoutine_OrASetWithAnUnknownExercise_IsRefusedByTheForeignKey()
    {
        var database = await MigratedAsync();
        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            var session = NewSession(Guid.NewGuid());
            session.RoutineId = Guid.NewGuid();
            db.Add(session);
            var act = () => db.SaveChangesAsync(Ct);
            (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
                .Which.SqlState.Should().Be("23503");
        }

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            var session = NewSession(Guid.NewGuid());
            db.Add(session);
            db.Add(NewSet(session.UserId, session.Id, Guid.NewGuid()));
            var act = () => db.SaveChangesAsync(Ct);
            (await act.Should().ThrowAsync<DbUpdateException>()).Which.InnerException.Should().BeOfType<PostgresException>()
                .Which.SqlState.Should().Be("23503");
        }
    }

    [Fact]
    public async Task DeletingASessionRow_RemovesItsSets_ButAnExerciseInUseCannotBeDeleted()
    {
        var database = await MigratedAsync();
        Guid exercise;
        var session = NewSession(Guid.NewGuid(), finishedAt: DateTimeOffset.UtcNow);
        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            exercise = await SeedExerciseAsync(db);
            db.Add(session);
            await db.SaveChangesAsync(Ct);
            db.Add(NewSet(session.UserId, session.Id, exercise));
            await db.SaveChangesAsync(Ct);
        }

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            var act = () => db.Exercises.Where(e => e.Id == exercise).ExecuteDeleteAsync(Ct);
            (await act.Should().ThrowAsync<PostgresException>()).Which.SqlState.Should().Be("23001");
        }

        await using (var db = TrainingApp.CreateContext(database.OwnerConnection))
        {
            await db.Set<Session>().Where(s => s.Id == session.Id).ExecuteDeleteAsync(Ct);
            (await db.Set<SessionSet>().CountAsync(Ct)).Should().Be(0, "as séries morrem com o treino");
        }
    }

    [Fact]
    public async Task TheModule_AddsSessionRoutes_AllAuthorized_NoneAnonymous_AndNoDelete()
    {
        await using var factory = await GuardHost.StartAsync(postgres, "Production");
        var routes = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Where(r => (r.RoutePattern.RawText ?? string.Empty) is var text
                && (text.StartsWith("/api/v1/training/sessions", StringComparison.Ordinal) || text == "/api/v1/training/sets"))
            .ToList();

        routes.Select(r => r.RoutePattern.RawText).Should().BeEquivalentTo(
        [
            "/api/v1/training/sessions",
            "/api/v1/training/sessions/{id:guid}",
            "/api/v1/training/sessions/{sessionId:guid}/sets/{id:guid}",
            "/api/v1/training/sets",
        ]);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<IAuthorizeData>() != null);
        routes.Should().OnlyContain(r => r.Metadata.GetMetadata<IAllowAnonymous>() == null);
        routes.SelectMany(r => r.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? []).Should().NotContain("DELETE");
        PublicRoutes.All.Should().NotContain(r => r.Pattern.Contains("session", StringComparison.Ordinal) || r.Pattern.Contains("/sets", StringComparison.Ordinal));
    }
}
