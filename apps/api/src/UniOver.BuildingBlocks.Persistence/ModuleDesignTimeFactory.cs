using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// Usada só pelo <c>dotnet ef</c> (migrations e bundle). Lê a conexão DIRETA, com o papel dono, de
/// <c>UNIOVER_MIGRATIONS_CONNECTION</c>: o pooler do Neon (PgBouncer em modo transação) não suporta o advisory
/// lock de sessão que as migrations do EF Core usam.
/// </summary>
public abstract class ModuleDesignTimeFactory<TContext> : IDesignTimeDbContextFactory<TContext>
    where TContext : ModuleDbContext
{
    public const string ConnectionVariable = "UNIOVER_MIGRATIONS_CONNECTION";

    protected abstract string Schema { get; }

    protected abstract TContext Create(DbContextOptions<TContext> options);

    public TContext CreateDbContext(string[] args)
    {
        var connection = Environment.GetEnvironmentVariable(ConnectionVariable);
        if (string.IsNullOrWhiteSpace(connection))
        {
            throw new InvalidOperationException(
                $"Defina {ConnectionVariable} com a conexão direta (papel dono) para rodar migrations.");
        }

        var builder = new DbContextOptionsBuilder<TContext>();
        ModuleDatabase.Configure(builder, connection, Schema, typeof(TContext).Assembly);
        return Create(builder.Options);
    }
}
