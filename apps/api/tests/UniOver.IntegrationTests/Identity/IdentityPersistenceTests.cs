using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class IdentityPersistenceTests(PostgresFixture postgres) : IDisposable
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // Fecha os pools deste teste (cada um tem o seu banco): evita esgotar as conexões do contêiner compartilhado.
    public void Dispose() => NpgsqlConnection.ClearAllPools();

    private static async Task<List<string>> QueryAsync(string connection, string sql)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(sql, conn);
        await using var reader = await command.ExecuteReaderAsync(Ct);
        var rows = new List<string>();
        while (await reader.ReadAsync(Ct))
        {
            rows.Add(reader.GetValue(0).ToString()!);
        }

        return rows;
    }

    private async Task<TestDatabase> MigratedDatabaseAsync()
    {
        // O mesmo caminho do bundle (o migrator do EF) com o papel dono, em banco vazio.
        var database = await postgres.CreateDatabaseAsync();
        await using var context = IdentityApp.CreateContext(database.OwnerConnection);
        await context.Database.MigrateAsync(Ct);
        return database;
    }

    [Fact]
    public async Task Migrations_OnAnEmptyDatabase_CreateOnlyIdentityObjects_WithItsOwnHistoryTable()
    {
        var database = await MigratedDatabaseAsync();

        var tables = await QueryAsync(database.OwnerConnection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'identity' ORDER BY table_name");
        var publicTables = await QueryAsync(database.OwnerConnection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        var otherSchemas = await QueryAsync(database.OwnerConnection,
            "SELECT schema_name FROM information_schema.schemata "
            + "WHERE schema_name NOT IN ('public', 'information_schema', 'identity') AND schema_name NOT LIKE 'pg_%'");

        tables.Should().Equal(
            "__ef_migrations_history", "guest_invites", "login_audit", "passkeys", "refresh_tokens", "step_up_confirmations", "users", "webauthn_challenges");
        publicTables.Should().BeEmpty();
        otherSchemas.Should().BeEmpty();
    }

    [Fact]
    public async Task Migrations_CreateNoForeignKeyAcrossSchemas()
    {
        var database = await MigratedDatabaseAsync();

        var crossing = await QueryAsync(database.OwnerConnection,
            "SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_class r ON r.oid = c.confrelid "
            + "WHERE c.contype = 'f' AND t.relnamespace <> r.relnamespace");

        crossing.Should().Equal("0");
    }

    [Fact]
    public async Task UsersTable_HasNoPasswordExpiryOrProvisionalMarker()
    {
        var database = await MigratedDatabaseAsync();

        var columns = await QueryAsync(database.OwnerConnection,
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'users' ORDER BY column_name");

        columns.Should().Equal(
            "created_at", "disabled_at", "display_name", "email", "failed_login_count", "id", "last_failed_at", "lockout_until", "password_hash", "role");
    }

    [Fact]
    public async Task RuntimeRole_CanReadAndWriteTheModuleTables_ButCannotRunDdlOrTouchTheHistory()
    {
        var database = await MigratedDatabaseAsync();
        var runtime = ModuleDatabase.BuildRuntimeConnectionString(new DatabaseOptions { ConnectionString = database.RuntimeConnection });

        await using (var write = IdentityApp.CreateContext(runtime))
        {
            write.Users.Add(User.Create("a@uniover.test", "a", "hash", DateTimeOffset.UtcNow));
            await write.SaveChangesAsync(Ct);
        }

        await using (var read = IdentityApp.CreateContext(runtime))
        {
            (await read.Users.CountAsync(Ct)).Should().Be(1);
        }

        foreach (var sql in new[]
        {
            "CREATE TABLE identity.intruder (id int)",
            "DELETE FROM identity.__ef_migrations_history",
            "DROP TABLE identity.users",
        })
        {
            await using var conn = new NpgsqlConnection(database.RuntimeConnection);
            await conn.OpenAsync(Ct);
            await using var command = new NpgsqlCommand(sql, conn);
            var act = async () => await command.ExecuteNonQueryAsync(Ct);

            var error = await act.Should().ThrowAsync<PostgresException>();
            error.Which.SqlState.Should().Be("42501", "insufficient_privilege");
        }
    }

    [Fact]
    public void IdempotentScript_ContainsTheSchemaTablesAndGrants()
    {
        using var context = IdentityApp.CreateContext("Host=localhost;Database=unused;Username=unused;Password=unused");
        var script = context.GetService<IMigrator>().GenerateScript(options: MigrationsSqlGenerationOptions.Idempotent);

        script.Should().Contain("CREATE TABLE identity.users");
        script.Should().Contain("CREATE TABLE identity.refresh_tokens");
        script.Should().Contain("CREATE TABLE identity.login_audit");
        script.Should().Contain("__ef_migrations_history");
        script.Should().Contain("GRANT USAGE ON SCHEMA \"identity\"");
    }

    [Fact]
    public async Task DeletingTheOwnerRow_IsTheManualRecoveryPath_TheSeedRecreatesTheAccount()
    {
        await using var first = await IdentityApp.StartAsync(postgres);
        var login = await first.LoginAsync();

        // Caminho manual descrito para o dono: apagar a linha de identity.users (no Neon, pelo console).
        await using (var db = first.Db())
        {
            (await db.Database.ExecuteSqlRawAsync("DELETE FROM identity.users", Ct)).Should().Be(1);
            (await db.RefreshTokens.CountAsync(Ct)).Should().Be(0, "as sessões saem junto");
            (await db.LoginAudit.CountAsync(Ct)).Should().BeGreaterThan(0, "a trilha sobrevive");
        }

        (await first.RefreshRawAsync(login.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var newPassword = IdentityApp.NewPassword();
        await using var second = await IdentityApp.StartAsync(postgres, new IdentityAppOptions
        {
            Database = first.Database,
            OwnerPassword = newPassword,
        });

        (await second.LoginRawAsync(second.OwnerEmail, newPassword)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task DeletingOnlyTheOwnerRow_WithAGuestStillThere_TheSeedStillRecreatesTheOwner()
    {
        await using var first = await IdentityApp.StartAsync(postgres);
        await using (var db = first.Db())
        {
            db.Users.Add(User.CreateGuest("convidada@uniover.test", "Convidada", "hash", DateTimeOffset.UtcNow));
            await db.SaveChangesAsync(Ct);
            (await db.Database.ExecuteSqlRawAsync("DELETE FROM identity.users WHERE role = 'owner'", Ct)).Should().Be(1);
        }

        var newPassword = IdentityApp.NewPassword();
        await using var second = await IdentityApp.StartAsync(postgres, new IdentityAppOptions
        {
            Database = first.Database,
            OwnerPassword = newPassword,
        });

        (await second.LoginRawAsync(second.OwnerEmail, newPassword)).StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = second.Db();
        (await check.Users.CountAsync(u => u.Role == "owner", Ct)).Should().Be(1);
        (await check.Users.CountAsync(u => u.Role == "guest", Ct)).Should().Be(1);
    }

    [Fact]
    public async Task RoleMigration_OverAnExistingAccount_KeepsItAsTheOwner_WithoutRewritingHistory()
    {
        // O que a produção vive por alguns minutos: tabela já migrada para o esquema novo, código antigo escrevendo
        // sem conhecer a coluna de papel. A linha que existia antes e a que o código antigo grava viram dono.
        var database = await postgres.CreateDatabaseAsync();
        await using (var context = IdentityApp.CreateContext(database.OwnerConnection))
        {
            var migrator = context.GetService<IMigrator>();
            await migrator.MigrateAsync("20261018223021_AddPasskeysAndStepUp", Ct);
            await context.Database.ExecuteSqlRawAsync(
                "INSERT INTO identity.users (id, email, display_name, password_hash, created_at, failed_login_count) "
                + "VALUES ('0192f1e4-0000-7000-8000-000000000001', 'antigo@uniover.test', 'antigo', 'hash', now(), 0)", Ct);
            await migrator.MigrateAsync(null, Ct);

            // Código antigo depois do esquema novo: insere sem a coluna `role`.
            await context.Database.ExecuteSqlRawAsync(
                "INSERT INTO identity.users (id, email, display_name, password_hash, created_at, failed_login_count) "
                + "VALUES ('0192f1e4-0000-7000-8000-000000000002', 'outro@uniover.test', 'outro', 'hash', now(), 0)", Ct);
        }

        var roles = await QueryAsync(database.OwnerConnection, "SELECT role FROM identity.users ORDER BY email");
        var applied = await QueryAsync(database.OwnerConnection, "SELECT migration_id FROM identity.__ef_migrations_history ORDER BY migration_id");

        roles.Should().Equal("owner", "owner");
        applied.Should().StartWith("20261018215747_InitialCreate", "20261018223021_AddPasskeysAndStepUp");
        applied.Should().HaveCount(3);

        // O banco recusa um papel inventado.
        await using var conn = new NpgsqlConnection(database.OwnerConnection);
        await conn.OpenAsync(Ct);
        await using var bad = new NpgsqlCommand("UPDATE identity.users SET role = 'admin'", conn);
        var act = async () => await bad.ExecuteNonQueryAsync(Ct);
        (await act.Should().ThrowAsync<PostgresException>()).Which.SqlState.Should().Be("23514");
    }
}
