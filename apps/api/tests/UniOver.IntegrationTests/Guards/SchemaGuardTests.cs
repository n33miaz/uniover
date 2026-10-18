using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Guards;

/// <summary>
/// Regra de fronteira entre módulos no banco real: todas as migrations aplicadas num único banco, e então nenhuma
/// chave estrangeira nem view cruza schemas, nada cai em <c>public</c> e cada schema tem o próprio histórico.
/// Módulo novo entra sozinho pelo <see cref="ModuleDbContextRegistry"/>.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class SchemaGuardTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Migra todos os contextos registrados num banco novo, cada um pela conexão do papel dono.</summary>
    private async Task<(TestDatabase Database, IReadOnlyList<ModuleDbContextRegistration> Modules)> MigrateAllAsync()
    {
        var database = await postgres.CreateDatabaseAsync();

        IReadOnlyList<ModuleDbContextRegistration> modules;
        await using (var factory = await GuardHost.StartAsync(postgres, "Production"))
            modules = factory.Services.GetRequiredService<ModuleDbContextRegistry>().Registrations;
        {
        }

        modules.Should().NotBeEmpty("sem módulos registrados o teste passaria sem verificar nada");
        foreach (var module in modules)
        {
            var optionsType = typeof(DbContextOptionsBuilder<>).MakeGenericType(module.ContextType);
            var builder = (DbContextOptionsBuilder)Activator.CreateInstance(optionsType)!;
            ModuleDatabase.Configure(builder, database.OwnerConnection, module.Schema, module.ContextType.Assembly);

            await using var context = (DbContext)Activator.CreateInstance(module.ContextType, builder.Options)!;
            await context.Database.MigrateAsync(Ct);
        }

        NpgsqlConnection.ClearAllPools();
        return (database, modules);
    }

    [Fact]
    public async Task AllModules_AfterMigrate_HaveNoForeignKeyOrViewAcrossSchemas()
    {
        var (database, _) = await MigrateAllAsync();

        var foreignKeys = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.CrossSchemaForeignKeys, Ct);
        var views = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.CrossSchemaViews, Ct);

        foreignKeys.Should().BeEmpty("outro módulo é referenciado só por id, nunca por chave estrangeira (tabela_origem -> tabela_destino)");
        views.Should().BeEmpty("view de um módulo não pode ler tabela de outro (view -> tabela)");
    }

    [Fact]
    public async Task AllModules_AfterMigrate_KeepEverythingInTheirOwnSchema()
    {
        var (database, modules) = await MigrateAllAsync();
        var schemas = modules.Select(m => m.Schema).ToArray();

        var inPublic = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.PublicObjects, Ct);
        var withoutHistory = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection, SchemaGuardQueries.SchemasWithoutHistory, Ct, schemas);

        inPublic.Should().BeEmpty("nenhum objeto de módulo pode cair em public, nem o histórico de migrations");
        withoutHistory.Should().BeEmpty("cada módulo guarda o próprio __ef_migrations_history dentro do seu schema");
    }

    // Prova de que a guarda morde: o mesmo SQL contra um banco onde o problema foi criado de propósito.
    // Sem isto, um teste verde poderia ser apenas silêncio.

    private async Task<TestDatabase> ScratchAsync(string setupSql)
    {
        var database = await postgres.CreateDatabaseAsync();
        await SchemaGuardQueries.ExecuteAsync(database.OwnerConnection, setupSql, Ct);
        return database;
    }

    [Fact]
    public async Task ForeignKeyQuery_DetectsForeignKeyBetweenSchemas()
    {
        var database = await ScratchAsync("""
            CREATE SCHEMA guard_a;
            CREATE SCHEMA guard_b;
            CREATE TABLE guard_b.parent (id uuid PRIMARY KEY);
            CREATE TABLE guard_a.child (id uuid PRIMARY KEY, parent_id uuid REFERENCES guard_b.parent (id));
            """);

        var found = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.CrossSchemaForeignKeys, Ct);

        found.Should().Equal("guard_a.child -> guard_b.parent");
    }

    [Fact]
    public async Task ForeignKeyQuery_IgnoresForeignKeyInsideTheSameSchema()
    {
        var database = await ScratchAsync("""
            CREATE SCHEMA guard_a;
            CREATE TABLE guard_a.parent (id uuid PRIMARY KEY);
            CREATE TABLE guard_a.child (id uuid PRIMARY KEY, parent_id uuid REFERENCES guard_a.parent (id));
            """);

        var found = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.CrossSchemaForeignKeys, Ct);

        found.Should().BeEmpty();
    }

    [Fact]
    public async Task ViewQuery_DetectsViewReadingAnotherSchema_AndIgnoresViewInsideItsOwn()
    {
        var database = await ScratchAsync("""
            CREATE SCHEMA guard_a;
            CREATE SCHEMA guard_b;
            CREATE TABLE guard_a.own (id uuid PRIMARY KEY);
            CREATE TABLE guard_b.other (id uuid PRIMARY KEY);
            CREATE VIEW guard_a.own_view AS SELECT id FROM guard_a.own;
            CREATE VIEW guard_a.spy_view AS SELECT o.id FROM guard_a.own o JOIN guard_b.other x ON x.id = o.id;
            CREATE MATERIALIZED VIEW guard_a.spy_materialized AS SELECT id FROM guard_b.other;
            """);

        var found = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.CrossSchemaViews, Ct);

        found.Should().Equal("guard_a.spy_materialized -> guard_b.other", "guard_a.spy_view -> guard_b.other");
    }

    [Fact]
    public async Task PublicQuery_DetectsTableAndMigrationHistoryInPublic()
    {
        var database = await ScratchAsync("""
            CREATE TABLE public.stray (id int);
            CREATE TABLE public.__ef_migrations_history (id int);
            """);

        var found = await SchemaGuardQueries.RunAsync(database.OwnerConnection, SchemaGuardQueries.PublicObjects, Ct);

        found.Should().Equal("__ef_migrations_history", "stray");
    }

    [Fact]
    public async Task HistoryQuery_DetectsSchemaWithoutMigrationHistory()
    {
        var database = await ScratchAsync("""
            CREATE SCHEMA guard_a;
            CREATE SCHEMA guard_b;
            CREATE TABLE guard_a.__ef_migrations_history (id int);
            """);

        var found = await SchemaGuardQueries.RunAsync(
            database.OwnerConnection, SchemaGuardQueries.SchemasWithoutHistory, Ct, ["guard_a", "guard_b"]);

        found.Should().Equal("guard_b");
    }
}
