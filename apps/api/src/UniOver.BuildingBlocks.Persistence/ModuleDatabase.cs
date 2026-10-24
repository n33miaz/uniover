using System.Reflection;
using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// Configuração do Npgsql compartilhada pela aplicação e pelo <c>dotnet ef</c>. Ficar num lugar só garante que o
/// modelo visto pelas migrations (snake_case, tabela de histórico no schema) é o mesmo da execução.
/// </summary>
public static class ModuleDatabase
{
    public const string MigrationsHistoryTable = "__ef_migrations_history";

    public static void Configure(
        DbContextOptionsBuilder builder,
        string connectionString,
        string schema,
        Assembly migrationsAssembly)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(migrationsAssembly);

        builder
            .UseNpgsql(connectionString, npgsql => npgsql
                // A tabela de histórico mora no schema do módulo (cada módulo migra sozinho).
                .MigrationsHistoryTable(MigrationsHistoryTable, schema)
                .MigrationsAssembly(migrationsAssembly.GetName().Name))
            .UseSnakeCaseNamingConvention();
    }

    /// <summary>
    /// Configura um contexto para a conexão da requisição. Os módulos continuam com modelos e schemas próprios, mas uma
    /// ação que precisa gravar em mais de um deles pode usar uma única transação do Postgres.
    /// </summary>
    public static void Configure(
        DbContextOptionsBuilder builder,
        DbConnection connection,
        string schema,
        Assembly migrationsAssembly)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(migrationsAssembly);

        builder
            .UseNpgsql(connection, npgsql => npgsql
                .MigrationsHistoryTable(MigrationsHistoryTable, schema)
                .MigrationsAssembly(migrationsAssembly.GetName().Name))
            .UseSnakeCaseNamingConvention();
    }

    /// <summary>
    /// Ajusta a string da aplicação para o pooler em modo transação. Sem multiplexação (ela mantém conexões
    /// presas ao servidor) e sem retry automático de conexão (conflitaria com a transação da outbox).
    /// </summary>
    public static string BuildRuntimeConnectionString(DatabaseOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var builder = new NpgsqlConnectionStringBuilder(options.ConnectionString)
        {
            Multiplexing = false,
            MaxPoolSize = options.MaxPoolSize,
            Timeout = options.ConnectionTimeoutSeconds,
            NoResetOnClose = options.NoResetOnClose,
        };
        return builder.ConnectionString;
    }
}
