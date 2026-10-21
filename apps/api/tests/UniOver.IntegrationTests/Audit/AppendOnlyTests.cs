using System.Globalization;
using AwesomeAssertions;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;
using static UniOver.IntegrationTests.Audit.AuditKit;

namespace UniOver.IntegrationTests.Audit;

/// <summary>
/// A trilha só aceita inclusão pelo papel da aplicação, e isso vale DEPOIS de todas as migrations (e depois de qualquer
/// migration futura que chame o auxiliar de permissões). Cada teste olha o catálogo do Postgres, não a intenção.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class AppendOnlyTests(PostgresFixture postgres)
{
    private const string Runtime = PostgresFixture.RuntimeRole;

    private static readonly string[] Privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"];

    private static async Task<bool> HasAsync(string connection, string schema, string table, string privilege) =>
        await ScalarAsync(
            connection,
            "SELECT CASE WHEN has_table_privilege(@role::name, format('%I.%I', @schema::text, @table::text), @privilege::text) THEN 1 ELSE 0 END",
            ("role", Runtime), ("schema", schema), ("table", table), ("privilege", privilege)) == 1;

    private static async Task<Dictionary<string, bool>> PrivilegesAsync(string connection, string schema, string table)
    {
        var result = new Dictionary<string, bool>();
        foreach (var privilege in Privileges)
        {
            result[privilege] = await HasAsync(connection, schema, table, privilege);
        }

        return result;
    }

    private static IEnumerable<(string Schema, string Table)> AuditTables() =>
        AppendOnlyTables.All.SelectMany(s => s.Value.Select(t => (s.Key, t)));

    [Fact]
    public async Task EveryAuditTable_AfterAllMigrations_CanOnlyBeReadAndAppended()
    {
        var (database, _) = await MigrateEverythingAsync(postgres);

        AuditTables().Should().NotBeEmpty("sem tabelas de auditoria o teste passaria sem verificar nada");
        foreach (var (schema, table) in AuditTables())
        {
            var granted = await PrivilegesAsync(database.OwnerConnection, schema, table);

            granted["SELECT"].Should().BeTrue($"{schema}.{table}: a aplicação lê a trilha");
            granted["INSERT"].Should().BeTrue($"{schema}.{table}: a aplicação inclui na trilha");
            granted["UPDATE"].Should().BeFalse($"{schema}.{table}: a trilha não se edita");
            granted["DELETE"].Should().BeFalse($"{schema}.{table}: a trilha não se apaga pela aplicação");
            granted["TRUNCATE"].Should().BeFalse($"{schema}.{table}: nem se esvazia");
        }
    }

    [Fact]
    public async Task TheRuntimeRole_CannotChangeOrDeleteAnAuditRow_ButCanStillInsert()
    {
        var (database, _) = await MigrateEverythingAsync(postgres);
        await ExecuteAsync(database.OwnerConnection,
            "INSERT INTO tv.command_audit (id, user_id, command, ok, occurred_at) VALUES (gen_random_uuid(), gen_random_uuid(), 'tv.key', true, now())");

        await ExecuteAsync(database.RuntimeConnection,
            "INSERT INTO tv.command_audit (id, user_id, command, ok, occurred_at) VALUES (gen_random_uuid(), gen_random_uuid(), 'tv.key', true, now())");

        foreach (var sql in new[]
        {
            "UPDATE tv.command_audit SET ok = false",
            "DELETE FROM tv.command_audit",
            "TRUNCATE tv.command_audit",
            "UPDATE identity.login_audit SET event = 'x'",
            "DELETE FROM identity.login_audit",
            "UPDATE devices.pairing_audit SET event = 'x'",
            "DELETE FROM devices.pairing_audit",
        })
        {
            var act = async () => await ExecuteAsync(database.RuntimeConnection, sql);

            var error = await act.Should().ThrowAsync<PostgresException>(sql);
            error.Which.SqlState.Should().Be("42501", $"insufficient_privilege: {sql}");
        }

        (await ScalarAsync(database.OwnerConnection, "SELECT count(*) FROM tv.command_audit")).Should().Be(2);
    }

    [Fact]
    public async Task EveryOtherTable_KeepsItsDml_SoTheExceptionDoesNotReachTooFar()
    {
        var (database, modules) = await MigrateEverythingAsync(postgres);
        var schemas = modules.Select(m => m.Schema).ToArray();

        var tables = new List<(string Schema, string Table)>();
        await using (var conn = new NpgsqlConnection(database.OwnerConnection))
        {
            await conn.OpenAsync(Ct);
            await using var command = new NpgsqlCommand(
                "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY(@schemas) AND c.relname <> '__ef_migrations_history'",
                conn);
            command.Parameters.AddWithValue("schemas", schemas);
            await using var reader = await command.ExecuteReaderAsync(Ct);
            while (await reader.ReadAsync(Ct))
            {
                tables.Add((reader.GetString(0), reader.GetString(1)));
            }
        }

        var audit = AuditTables().ToHashSet();
        var others = tables.Where(t => !audit.Contains(t)).ToList();
        others.Should().Contain(t => t.Schema == "tv" && t.Table == "watchdog_events", "o buffer do vigia continua aparável pelo módulo");
        others.Should().Contain(t => t.Schema == "identity" && t.Table == "users");

        foreach (var (schema, table) in others)
        {
            var granted = await PrivilegesAsync(database.OwnerConnection, schema, table);

            granted["SELECT"].Should().BeTrue($"{schema}.{table}");
            granted["INSERT"].Should().BeTrue($"{schema}.{table}");
            granted["UPDATE"].Should().BeTrue($"{schema}.{table}");
            granted["DELETE"].Should().BeTrue($"{schema}.{table}");
        }
    }

    [Fact]
    public async Task EveryTableWithAuditInItsName_IsInTheAppendOnlyList_AndEveryListedTableExists()
    {
        var (database, modules) = await MigrateEverythingAsync(postgres);
        var schemas = modules.Select(m => m.Schema).ToArray();
        var found = new List<(string Schema, string Table)>();
        await using (var conn = new NpgsqlConnection(database.OwnerConnection))
        {
            await conn.OpenAsync(Ct);
            await using var command = new NpgsqlCommand(
                "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY(@schemas) AND c.relname ILIKE '%audit%'",
                conn);
            command.Parameters.AddWithValue("schemas", schemas);
            await using var reader = await command.ExecuteReaderAsync(Ct);
            while (await reader.ReadAsync(Ct))
            {
                found.Add((reader.GetString(0), reader.GetString(1)));
            }
        }

        found.Should().NotBeEmpty();
        found.Should().BeSubsetOf(AuditTables().ToList(), "tabela de auditoria nova precisa entrar em AppendOnlyTables");
        AuditTables().ToList().Should().BeSubsetOf(found, "a lista não pode citar tabela que não existe (erro de digitação)");
    }

    [Fact]
    public async Task TheTvMigrations_ApplyInOrder_AndTheAppendOnlyExceptionSurvivesTheLaterOnes()
    {
        var (database, _) = await MigrateEverythingAsync(postgres);

        var ids = new List<string>();
        await using (var conn = new NpgsqlConnection(database.OwnerConnection))
        {
            await conn.OpenAsync(Ct);
            await using var command = new NpgsqlCommand("SELECT migration_id FROM tv.__ef_migrations_history ORDER BY migration_id", conn);
            await using var reader = await command.ExecuteReaderAsync(Ct);
            while (await reader.ReadAsync(Ct))
            {
                ids.Add(reader.GetString(0));
            }
        }

        // A migration de auditoria vem antes de uma que cria tabela nova (AddTvs, que não chama o auxiliar: a tabela nova ganha
        // DML pelos privilégios padrão do schema). Nada nela pode devolver o DELETE da trilha.
        var audit = ids.FindIndex(i => i.EndsWith("_AddAuditAppendOnlyAndRetention", StringComparison.Ordinal));
        var later = ids.FindIndex(i => i.EndsWith("_AddTvs", StringComparison.Ordinal));
        audit.Should().BeGreaterThan(-1);
        later.Should().BeGreaterThan(audit, "o teste só prova algo se uma migration que cria tabela roda DEPOIS da de auditoria");

        (await HasAsync(database.OwnerConnection, "tv", "command_audit", "DELETE")).Should().BeFalse();
        (await HasAsync(database.OwnerConnection, "tv", "command_audit", "UPDATE")).Should().BeFalse();
        (await HasAsync(database.OwnerConnection, "tv", "tvs", "DELETE")).Should().BeTrue("a tabela nova segue com DML");
    }

    [Fact]
    public async Task ALaterMigrationCallingThePlainHelper_DoesNotGiveTheDeleteBack_AndIsIdempotent()
    {
        var (database, _) = await MigrateEverythingAsync(postgres);

        // O que uma migration futura faz ao criar qualquer tabela: chama o auxiliar só com o nome do schema.
        for (var round = 0; round < 2; round++)
        {
            foreach (var schema in new[] { "identity", "devices", "tv" })
            {
                await ExecuteAsync(database.OwnerConnection, RuntimeRoleGrants.Sql(schema));
            }
        }

        foreach (var (schema, table) in AuditTables())
        {
            var granted = await PrivilegesAsync(database.OwnerConnection, schema, table);
            granted["DELETE"].Should().BeFalse($"{schema}.{table}");
            granted["UPDATE"].Should().BeFalse($"{schema}.{table}");
            granted["INSERT"].Should().BeTrue($"{schema}.{table}");
        }

        (await HasAsync(database.OwnerConnection, "tv", "shortcuts", "DELETE")).Should().BeTrue("as outras tabelas seguem com DML");
    }

    // Prova de que a guarda morde: sem a exceção o mesmo SQL de concessões devolve o DELETE.

    private const string OldGrants = """
        DO $$
        BEGIN
          GRANT USAGE ON SCHEMA scratch TO uniover_app;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA scratch TO uniover_app;
          ALTER DEFAULT PRIVILEGES IN SCHEMA scratch GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uniover_app;
        END
        $$;
        """;

    [Fact]
    public async Task WithoutTheException_TheGrantsGiveTheDeleteBack_AndTheHelperWithTheTableTakesItAway()
    {
        var database = await postgres.CreateDatabaseAsync();
        await ExecuteAsync(database.OwnerConnection, "CREATE SCHEMA scratch; CREATE TABLE scratch.__ef_migrations_history (id int); CREATE TABLE scratch.thing_audit (id uuid PRIMARY KEY); CREATE TABLE scratch.other (id uuid PRIMARY KEY)");

        await ExecuteAsync(database.OwnerConnection, OldGrants);
        (await HasAsync(database.OwnerConnection, "scratch", "thing_audit", "DELETE")).Should().BeTrue("o SQL antigo concede tudo");

        await ExecuteAsync(database.OwnerConnection, RuntimeRoleGrants.Sql("scratch", ["thing_audit"]));

        (await HasAsync(database.OwnerConnection, "scratch", "thing_audit", "DELETE")).Should().BeFalse();
        (await HasAsync(database.OwnerConnection, "scratch", "thing_audit", "UPDATE")).Should().BeFalse();
        (await HasAsync(database.OwnerConnection, "scratch", "thing_audit", "INSERT")).Should().BeTrue();
        (await HasAsync(database.OwnerConnection, "scratch", "other", "DELETE")).Should().BeTrue();

        // Uma tabela de auditoria criada DEPOIS (o padrão do schema concede DML) também é fechada, na migration seguinte.
        await ExecuteAsync(database.OwnerConnection, "CREATE TABLE scratch.later_audit (id uuid PRIMARY KEY)");
        (await HasAsync(database.OwnerConnection, "scratch", "later_audit", "DELETE")).Should().BeTrue("o padrão do schema concede DML a toda tabela nova");
        await ExecuteAsync(database.OwnerConnection, RuntimeRoleGrants.Sql("scratch", ["thing_audit", "later_audit"]));
        (await HasAsync(database.OwnerConnection, "scratch", "later_audit", "DELETE")).Should().BeFalse();
    }

    [Fact]
    public async Task ListingATableThatDoesNotExistYet_IsHarmless()
    {
        var database = await postgres.CreateDatabaseAsync();
        await ExecuteAsync(database.OwnerConnection, "CREATE SCHEMA scratch; CREATE TABLE scratch.__ef_migrations_history (id int); CREATE TABLE scratch.other (id uuid PRIMARY KEY)");

        var act = async () => await ExecuteAsync(database.OwnerConnection, RuntimeRoleGrants.Sql("scratch", ["not_there_yet"]));

        await act.Should().NotThrowAsync("uma migration antiga num banco novo chama o auxiliar antes de a tabela existir");
        (await HasAsync(database.OwnerConnection, "scratch", "other", "DELETE")).Should().BeTrue();
    }

    [Fact]
    public void TheHelperSql_RevokesAfterItGrants_GuardsEachRevoke_AndRefusesBadNames()
    {
        var sql = RuntimeRoleGrants.Sql("tv");

        var grant = sql.IndexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES", StringComparison.Ordinal);
        var defaults = sql.IndexOf("ALTER DEFAULT PRIVILEGES", StringComparison.Ordinal);
        var revoke = sql.IndexOf("REVOKE UPDATE, DELETE, TRUNCATE ON \"tv\".\"command_audit\"", StringComparison.Ordinal);
        grant.Should().BeGreaterThan(-1);
        revoke.Should().BeGreaterThan(grant).And.BeGreaterThan(defaults, "a exceção vem depois de todo GRANT");
        sql.Should().Contain("to_regclass('\"tv\".\"command_audit\"')");
        sql.Should().NotContain("watchdog_events", "o buffer do vigia não é trilha de auditoria");

        RuntimeRoleGrants.Sql("training").Should().NotContain("REVOKE UPDATE", "schema sem tabela de auditoria não revoga nada");
        RuntimeRoleGrants.Sql("tv", []).Should().NotContain("REVOKE UPDATE");

        var bad = () => RuntimeRoleGrants.Sql("tv", ["x\"; DROP TABLE y; --"]);
        bad.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void GrantExecuteSql_NamesTheFunctionAndValidatesIdentifiers()
    {
        RuntimeRoleGrants.GrantExecuteSql("tv", "purge_audit")
            .Should().Contain("GRANT EXECUTE ON FUNCTION \"tv\".\"purge_audit\"(integer) TO \"uniover_app\"");

        var bad = () => RuntimeRoleGrants.GrantExecuteSql("tv", "f(); DROP SCHEMA tv");
        bad.Should().Throw<ArgumentException>();
        var badSchema = () => RuntimeRoleGrants.GrantExecuteSql("Tv", "purge_audit");
        badSchema.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void TheRetentionPeriods_AreNamedConstants()
    {
        // O prazo é uma promessa de privacidade; mudar este número exige mudar o piso nas funções do banco (migration).
        AuditRetentionPolicy.SecurityDays.Should().Be(180);
        AuditRetentionPolicy.CommandDays.Should().Be(30);
        string.Create(CultureInfo.InvariantCulture, $"{AuditRetentionPolicy.SecurityDays}/{AuditRetentionPolicy.CommandDays}")
            .Should().Be("180/30");
    }

    [Fact]
    public void PurgeOptions_Defaults_AreSane()
    {
        var options = new AuditPurgeOptions();

        options.FirstRunDelay.Should().BeGreaterThan(TimeSpan.Zero);
        options.Interval.Should().Be(TimeSpan.FromDays(1));
        AuditPurgeOptions.IsValid(options).Should().BeTrue();
        AuditPurgeOptions.IsValid(new AuditPurgeOptions { FirstRunDelayMinutes = 0 }).Should().BeFalse();
        AuditPurgeOptions.IsValid(new AuditPurgeOptions { IntervalHours = 0 }).Should().BeFalse();
    }

    [Fact]
    public void TheAppendOnlyRegistry_NamesTheThreeAuditTables()
    {
        AppendOnlyTables.All.Keys.Should().BeEquivalentTo("identity", "devices", "tv");
        AppendOnlyTables.Of("identity").Should().Equal("login_audit");
        AppendOnlyTables.Of("devices").Should().Equal("pairing_audit");
        AppendOnlyTables.Of("tv").Should().Equal("command_audit");
        AppendOnlyTables.Of("training").Should().BeEmpty();
    }
}
