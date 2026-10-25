using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;

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
            "__ef_migrations_history", "guest_invites", "login_audit", "passkeys", "qr_login_requests", "refresh_tokens", "step_up_confirmations", "user_grants", "users",
            "webauthn_challenges");
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
            "created_at", "disabled_at", "display_name", "display_name_confirmed_at", "email", "failed_login_count", "id", "last_failed_at",
            "lockout_until", "password_hash", "role");
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
        // Migrations posteriores se acrescentam com o tempo; o que este teste prova é que as duas primeiras seguem intactas, na ordem.
        applied.Should().HaveCountGreaterThanOrEqualTo(4);

        // O banco recusa um papel inventado.
        await using var conn = new NpgsqlConnection(database.OwnerConnection);
        await conn.OpenAsync(Ct);
        await using var bad = new NpgsqlCommand("UPDATE identity.users SET role = 'admin'", conn);
        var act = async () => await bad.ExecuteNonQueryAsync(Ct);
        (await act.Should().ThrowAsync<PostgresException>()).Which.SqlState.Should().Be("23514");
    }

    private const string OwnerId = "0192f1e4-0000-7000-8000-0000000000a1";
    private const string InvitedGuestId = "0192f1e4-0000-7000-8000-0000000000a2";
    private const string RevokedGuestId = "0192f1e4-0000-7000-8000-0000000000a3";
    private const string OrphanGuestId = "0192f1e4-0000-7000-8000-0000000000a4";
    private const string PendingInviteId = "0192f1e4-0000-7000-8000-0000000000b1";

    [Fact]
    public async Task GrantsMigration_GivesTheGuestsThatAlreadyExist_ExactlyWhatTheyHaveToday_AndTheOwnerGetsNoRows()
    {
        // O esquema de antes das permissões, com um dono, três convidados (um revogado, um sem convite conhecido) e um convite pendente.
        var database = await postgres.CreateDatabaseAsync();
        await using (var context = IdentityApp.CreateContext(database.OwnerConnection))
        {
            var migrator = context.GetService<IMigrator>();
            await migrator.MigrateAsync("20261020095337_AddGuestRoleAndInvites", Ct);
            await SeedPreGrantsDataAsync(context);
            await migrator.MigrateAsync(null, Ct);
        }

        // O que a convidada de hoje tem: a TV inteira, desligar inclusive, SEM editar atalhos. É o modelo do código.
        var expected = PermissionRules.TvControlOnly.Order(StringComparer.Ordinal).ToArray();
        expected.Should().Equal("module:tv", "tv:control", "tv:history", "tv:launch", "tv:power");

        foreach (var guest in new[] { InvitedGuestId, RevokedGuestId, OrphanGuestId })
        {
            var granted = await QueryAsync(database.OwnerConnection,
                $"SELECT permission FROM identity.user_grants WHERE user_id = '{guest}' ORDER BY permission COLLATE \"C\"");
            granted.Should().Equal(expected, $"o convidado {guest} tinha a TV inteira, sem editar atalhos");
        }

        (await QueryAsync(database.OwnerConnection, $"SELECT count(*) FROM identity.user_grants WHERE user_id = '{OwnerId}'"))
            .Should().Equal("0");
        (await QueryAsync(database.OwnerConnection, "SELECT count(*) FROM identity.user_grants"))
            .Should().Equal("15");

        // Quem concedeu: o dono do convite aceito; sem convite conhecido, a própria conta. Quando: a criação da conta.
        (await QueryAsync(database.OwnerConnection,
                $"SELECT DISTINCT granted_by::text FROM identity.user_grants WHERE user_id = '{InvitedGuestId}'"))
            .Should().Equal(OwnerId);
        (await QueryAsync(database.OwnerConnection,
                $"SELECT DISTINCT granted_by::text FROM identity.user_grants WHERE user_id = '{OrphanGuestId}'"))
            .Should().Equal(OrphanGuestId);
        (await QueryAsync(database.OwnerConnection,
                "SELECT count(*) FROM identity.user_grants g JOIN identity.users u ON u.id = g.user_id WHERE g.granted_at <> u.created_at"))
            .Should().Equal("0");

        // O convite que já existia fica com o mesmo modelo (o padrão da coluna), na mesma ordem do código.
        (await QueryAsync(database.OwnerConnection,
                $"SELECT array_to_string(permissions, ',') FROM identity.guest_invites WHERE id = '{PendingInviteId}'"))
            .Should().Equal(string.Join(',', PermissionRules.TvControlOnly));

        // Ninguém ganhou nome confirmado: o app pergunta o nome de todos no próximo acesso.
        (await QueryAsync(database.OwnerConnection, "SELECT count(*) FROM identity.users WHERE display_name_confirmed_at IS NOT NULL"))
            .Should().Equal("0");
    }

    [Fact]
    public async Task GrantsMigration_KeepsTheOldCodeWorking_WhileThePublicationIsInTheMiddle()
    {
        // Esquema novo, código antigo: o convite e a conta são gravados sem as colunas novas.
        var database = await MigratedDatabaseAsync();
        await using (var context = IdentityApp.CreateContext(database.OwnerConnection))
        {
            await context.Database.ExecuteSqlRawAsync(
                "INSERT INTO identity.users (id, email, display_name, password_hash, created_at, failed_login_count, role) "
                + $"VALUES ('{OwnerId}', 'dono@uniover.test', 'dono', 'hash', now(), 0, 'owner')", Ct);
            await context.Database.ExecuteSqlRawAsync(
                "INSERT INTO identity.guest_invites (id, token_hash, role, label, created_by, created_at, expires_at) "
                + $"VALUES ('{PendingInviteId}', '\\x01', 'guest', 'Antigo', '{OwnerId}', now(), now() + interval '1 day')", Ct);
        }

        (await QueryAsync(database.OwnerConnection,
                $"SELECT array_to_string(permissions, ',') FROM identity.guest_invites WHERE id = '{PendingInviteId}'"))
            .Should().Equal(string.Join(',', PermissionRules.TvControlOnly));
    }

    private static async Task SeedPreGrantsDataAsync(IdentityDbContext context)
    {
        const string user = "INSERT INTO identity.users (id, email, display_name, password_hash, created_at, failed_login_count, role, disabled_at) VALUES ";
        await context.Database.ExecuteSqlRawAsync(
            user + $"('{OwnerId}', 'dono@uniover.test', 'dono', 'hash', '2026-10-01 10:00+00', 0, 'owner', NULL), "
            + $"('{InvitedGuestId}', 'alice@uniover.test', 'Alice', 'hash', '2026-10-19 10:00+00', 0, 'guest', NULL), "
            + $"('{RevokedGuestId}', 'bia@uniover.test', 'Bia', 'hash', '2026-10-19 11:00+00', 0, 'guest', '2026-10-20 08:00+00'), "
            + $"('{OrphanGuestId}', 'caio@uniover.test', 'Caio', 'hash', '2026-10-19 12:00+00', 0, 'guest', NULL)", Ct);

        const string invite = "INSERT INTO identity.guest_invites (id, token_hash, role, label, created_by, created_at, expires_at, used_at, used_by) VALUES ";
        await context.Database.ExecuteSqlRawAsync(
            invite + $"('0192f1e4-0000-7000-8000-0000000000c2', '\\x02', 'guest', 'Alice', '{OwnerId}', '2026-10-19 09:00+00', '2026-10-21 09:00+00', '2026-10-19 10:00+00', '{InvitedGuestId}'), "
            + $"('0192f1e4-0000-7000-8000-0000000000c3', '\\x03', 'guest', 'Bia', '{OwnerId}', '2026-10-19 09:00+00', '2026-10-21 09:00+00', '2026-10-19 11:00+00', '{RevokedGuestId}'), "
            + $"('{PendingInviteId}', '\\x04', 'guest', 'Pendente', '{OwnerId}', '2026-10-20 09:00+00', '2026-10-22 09:00+00', NULL, NULL)", Ct);
    }

    [Fact]
    public async Task Database_RefusesAPermissionOutsideTheCatalog_AndAcceptsEveryOneInIt()
    {
        var database = await MigratedDatabaseAsync();
        await using var conn = new NpgsqlConnection(database.OwnerConnection);
        await conn.OpenAsync(Ct);
        await Exec(conn, "INSERT INTO identity.users (id, email, display_name, password_hash, created_at, failed_login_count, role) "
            + $"VALUES ('{InvitedGuestId}', 'alice@uniover.test', 'Alice', 'hash', now(), 0, 'guest')");

        // Todo item do catálogo do código passa na restrição do banco: se o catálogo crescer sem migration, este teste cai.
        foreach (var permission in AccessPermissions.All)
        {
            await Exec(conn, $"INSERT INTO identity.user_grants (user_id, permission, granted_by, granted_at) VALUES ('{InvitedGuestId}', '{permission}', '{OwnerId}', now())");
        }

        foreach (var bad in new[] { "nao-existe", "TV:CONTROL", "tv:*", "" })
        {
            var act = async () => await Exec(conn,
                $"INSERT INTO identity.user_grants (user_id, permission, granted_by, granted_at) VALUES ('{InvitedGuestId}', '{bad}', '{OwnerId}', now())");
            (await act.Should().ThrowAsync<PostgresException>()).Which.SqlState.Should().Be("23514", $"'{bad}' não é permissão");
        }

        // O convite também: lista vazia, item desconhecido e item repetido fora do catálogo.
        foreach (var bad in new[] { "ARRAY[]::text[]", "ARRAY['module:tv','nao-existe']::text[]", "ARRAY['TV:CONTROL']::text[]" })
        {
            var act = async () => await Exec(conn,
                "INSERT INTO identity.guest_invites (id, token_hash, role, label, created_by, created_at, expires_at, permissions) "
                + $"VALUES (gen_random_uuid(), '\\x05'::bytea, 'guest', 'x', '{OwnerId}', now(), now(), {bad})");
            (await act.Should().ThrowAsync<PostgresException>()).Which.SqlState.Should().Be("23514", bad);
        }
    }

    [Fact]
    public async Task UserGrants_AreRemovedWithTheAccount_AndTheRuntimeRoleCanUseThem()
    {
        var database = await MigratedDatabaseAsync();
        var runtime = ModuleDatabase.BuildRuntimeConnectionString(new DatabaseOptions { ConnectionString = database.RuntimeConnection });
        var now = DateTimeOffset.UtcNow;
        var guest = User.CreateGuest("alice@uniover.test", "Alice", "hash", now);

        await using (var write = IdentityApp.CreateContext(runtime))
        {
            write.Users.Add(guest);
            write.UserGrants.AddRange(PermissionRules.TvControlOnly.Select(p => UserGrant.Create(guest.Id, p, Guid.NewGuid(), now)));
            await write.SaveChangesAsync(Ct);
        }

        await using (var read = IdentityApp.CreateContext(runtime))
        {
            (await read.UserGrants.CountAsync(g => g.UserId == guest.Id, Ct)).Should().Be(5);
            (await read.Users.Where(u => u.Id == guest.Id).ExecuteDeleteAsync(Ct)).Should().Be(1);
            (await read.UserGrants.CountAsync(Ct)).Should().Be(0, "apagar a conta (caminho manual) leva as concessões junto");
        }
    }

    [Fact]
    public async Task ModelAndMigrations_AgreeOnTheNewTablesAndColumns_SoNoPendingChangeIsLeftBehind()
    {
        // O catálogo de permissões entra nas restrições do banco: permissão nova no código sem migration muda o modelo, e
        // é aqui (e no MigrateAsync de todos os outros testes) que isso aparece.
        await using var context = IdentityApp.CreateContext("Host=localhost;Database=unused;Username=unused;Password=unused");

        context.Database.HasPendingModelChanges().Should().BeFalse("o modelo do código e o último snapshot de migration precisam coincidir");
    }

    private static async Task Exec(NpgsqlConnection connection, string sql)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync(Ct);
    }
}
