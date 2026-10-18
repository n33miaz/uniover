using System.Diagnostics.CodeAnalysis;
using Npgsql;
using Testcontainers.PostgreSql;

namespace UniOver.IntegrationTests.Infrastructure;

/// <summary>Conexões de um banco de teste isolado: uma do papel dono (DDL) e uma do papel runtime (só DML).</summary>
public sealed record TestDatabase(string Name, string OwnerConnection, string RuntimeConnection);

/// <summary>
/// Um container <c>postgres:18</c> (a mesma major do Neon) por coleção de testes. No start cria os dois papéis
/// reais do projeto; cada teste pede o seu banco isolado com <see cref="CreateDatabaseAsync"/>.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    public const string OwnerRole = "uniover_owner";
    public const string RuntimeRole = "uniover_app";

    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder("postgres:18").Build();

    // Senhas descartáveis do container de teste, geradas a cada execução.
    private readonly string _ownerPassword = Guid.NewGuid().ToString("N");
    private readonly string _runtimePassword = Guid.NewGuid().ToString("N");

    public async ValueTask InitializeAsync()
    {
        await _container.StartAsync();

        await using var admin = new NpgsqlConnection(_container.GetConnectionString());
        await admin.OpenAsync();
        await ExecuteAsync(admin, $"CREATE ROLE {OwnerRole} LOGIN PASSWORD '{_ownerPassword}'");
        await ExecuteAsync(admin, $"CREATE ROLE {RuntimeRole} LOGIN PASSWORD '{_runtimePassword}'");
    }

    public async ValueTask DisposeAsync() => await _container.DisposeAsync();

    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities",
        Justification = "Nome do banco gerado a partir de um GUID e senhas geradas aqui; container descartável de teste.")]
    public async Task<TestDatabase> CreateDatabaseAsync()
    {
        var name = "t" + Guid.NewGuid().ToString("N");

        await using var admin = new NpgsqlConnection(_container.GetConnectionString());
        await admin.OpenAsync();
        await ExecuteAsync(admin, $"CREATE DATABASE {name} OWNER {OwnerRole}");
        await ExecuteAsync(admin, $"REVOKE ALL ON DATABASE {name} FROM PUBLIC");
        await ExecuteAsync(admin, $"GRANT CONNECT ON DATABASE {name} TO {RuntimeRole}");

        return new TestDatabase(
            name,
            ConnectionFor(name, OwnerRole, _ownerPassword),
            ConnectionFor(name, RuntimeRole, _runtimePassword));
    }

    private string ConnectionFor(string database, string user, string password) =>
        new NpgsqlConnectionStringBuilder(_container.GetConnectionString())
        {
            Database = database,
            Username = user,
            Password = password,
        }.ConnectionString;

    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities",
        Justification = "Só recebe SQL montado neste arquivo, com valores gerados.")]
    private static async Task ExecuteAsync(NpgsqlConnection connection, string sql)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }
}

[CollectionDefinition(Name)]
public sealed class PostgresGroup : ICollectionFixture<PostgresFixture>
{
    public const string Name = "postgres";
}
