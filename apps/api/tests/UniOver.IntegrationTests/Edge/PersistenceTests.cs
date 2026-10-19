using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.TestModule;

namespace UniOver.IntegrationTests.Edge;

[Collection(PostgresGroup.Name)]
public class PersistenceTests(PostgresFixture postgres)
{
    private static TestModuleDbContext CreateContext(string connection)
    {
        var builder = new DbContextOptionsBuilder<TestModuleDbContext>();
        ModuleDatabase.Configure(builder, connection, TestModuleDbContext.SchemaName, typeof(TestModuleDbContext).Assembly);
        return new TestModuleDbContext(builder.Options);
    }

    private static async Task<List<string>> QueryAsync(string connection, string sql)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand(sql, conn);
        await using var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
        var rows = new List<string>();
        while (await reader.ReadAsync(TestContext.Current.CancellationToken))
        {
            rows.Add(reader.GetString(0));
        }

        return rows;
    }

    private async Task<TestDatabase> MigratedDatabaseAsync()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using var context = CreateContext(database.OwnerConnection);
        await context.Database.MigrateAsync(TestContext.Current.CancellationToken);
        return database;
    }

    [Fact]
    public async Task Migrate_ByOwner_CreatesSchemaAndHistoryInsideModuleSchemaAndNothingInPublic()
    {
        var database = await MigratedDatabaseAsync();

        var moduleTables = await QueryAsync(database.OwnerConnection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'test_module' ORDER BY table_name");
        var publicTables = await QueryAsync(database.OwnerConnection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");

        moduleTables.Should().Equal("__ef_migrations_history", "items");
        publicTables.Should().BeEmpty("nenhum objeto de módulo pode cair em public");
    }

    [Fact]
    public async Task RuntimeRole_CanInsertAndSelect_ThroughTheModuleContext()
    {
        var database = await MigratedDatabaseAsync();
        var runtimeConnection = ModuleDatabase.BuildRuntimeConnectionString(
            new DatabaseOptions { ConnectionString = database.RuntimeConnection });

        await using (var write = CreateContext(runtimeConnection))
        {
            write.Items.Add(new TestItem { Id = Guid.CreateVersion7(), Name = "primeiro" });
            await write.SaveChangesAsync(TestContext.Current.CancellationToken);
        }

        await using var read = CreateContext(runtimeConnection);
        var names = await read.Items.Select(i => i.Name).ToListAsync(TestContext.Current.CancellationToken);
        names.Should().Equal("primeiro");
    }

    [Theory]
    [InlineData("CREATE TABLE test_module.intruder (id int)")]
    [InlineData("CREATE TABLE public.intruder (id int)")]
    [InlineData("CREATE SCHEMA intruder")]
    [InlineData("DELETE FROM test_module.__ef_migrations_history")]
    public async Task RuntimeRole_CannotRunDdlOrTouchMigrationHistory(string sql)
    {
        var database = await MigratedDatabaseAsync();

        await using var conn = new NpgsqlConnection(database.RuntimeConnection);
        await conn.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand(sql, conn);

        var act = async () => await command.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);

        var error = await act.Should().ThrowAsync<PostgresException>();
        error.Which.SqlState.Should().Be("42501", "insufficient_privilege");
    }

    [Theory]
    [InlineData("x; drop schema public")]
    [InlineData("Bad")]
    [InlineData("a")]
    [InlineData("1abc")]
    [InlineData("")]
    public void RuntimeRoleGrants_RejectsInvalidSchema(string schema)
    {
        var act = () => RuntimeRoleGrants.Sql(schema);

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void RuntimeRoleGrants_GrantsDmlButNeverCreate()
    {
        var sql = RuntimeRoleGrants.Sql("test_module");

        sql.Should().Contain("GRANT USAGE ON SCHEMA \"test_module\"");
        sql.Should().Contain("SELECT, INSERT, UPDATE, DELETE");
        sql.Should().NotContain("CREATE");
        sql.Should().NotContain("ALL PRIVILEGES");
    }

    [Fact]
    public void IdempotentMigrationScript_ContainsSchemaTableAndGrants()
    {
        // O bundle usa o mesmo caminho do migrator; o script idempotente prova o conteúdo sem custo de publicar.
        using var context = CreateContext("Host=localhost;Database=unused;Username=unused;Password=unused");
        var migrator = context.GetService<IMigrator>();

        var script = migrator.GenerateScript(options: MigrationsSqlGenerationOptions.Idempotent);

        script.Should().Contain("CREATE TABLE test_module.items");
        script.Should().Contain("__ef_migrations_history");
        script.Should().Contain("GRANT USAGE ON SCHEMA \"test_module\"");
    }

    [Fact]
    public void Registry_RejectsTwoModulesWithTheSameSchema()
    {
        var act = () => new ModuleDbContextRegistry(
        [
            new ModuleDbContextRegistration("a_schema", typeof(TestModuleDbContext)),
            new ModuleDbContextRegistration("a_schema", typeof(TestModuleDbContext)),
        ]);

        act.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void RuntimeConnectionString_DisablesMultiplexingAndAppliesPoolSettings()
    {
        var connection = ModuleDatabase.BuildRuntimeConnectionString(new DatabaseOptions
        {
            ConnectionString = "Host=h;Database=d;Username=u;Password=p",
        });

        var parsed = new NpgsqlConnectionStringBuilder(connection);
        parsed.Multiplexing.Should().BeFalse();
        parsed.MaxPoolSize.Should().Be(10);
        parsed.Timeout.Should().Be(15);
        parsed.NoResetOnClose.Should().BeFalse();
    }
}
