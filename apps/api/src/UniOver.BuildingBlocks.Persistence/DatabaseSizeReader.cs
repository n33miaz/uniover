using Microsoft.EntityFrameworkCore;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>Uma tabela e quanto ela ocupa com índices e TOAST (<c>pg_total_relation_size</c>).</summary>
public sealed class TableSize
{
    public string Schema { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public long Bytes { get; set; }
}

/// <summary>O tamanho lógico do banco e as maiores tabelas dos schemas pedidos.</summary>
public sealed record DatabaseSize(long DatabaseBytes, IReadOnlyList<TableSize> LargestTables);

/// <summary>
/// Leitura só de catálogo (nenhuma linha de módulo é lida): <c>pg_database_size</c> e <c>pg_total_relation_size</c>.
/// Funciona com o papel da aplicação, sem direito de DDL. O tamanho é o lógico do Postgres: o armazenamento que o provedor
/// cobra pode diferir um pouco, por isso quem mostra o número o chama de estimativa.
/// </summary>
public static class DatabaseSizeReader
{
    /// <summary>Lê o banco inteiro e as <paramref name="take"/> maiores tabelas dentro de <paramref name="schemas"/>.</summary>
    public static async Task<DatabaseSize> ReadAsync(
        DbContext context, IReadOnlyCollection<string> schemas, int take, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentOutOfRangeException.ThrowIfLessThan(take, 1);

        var total = await context.Database
            .SqlQuery<long>($"SELECT pg_database_size(current_database()) AS \"Value\"")
            .SingleAsync(cancellationToken);

        // Os schemas vêm do registro de módulos (nunca do pedido) e seguem como parâmetro; só tabelas comuns e particionadas.
        var names = schemas.ToArray();
        var tables = await context.Database
            .SqlQuery<TableSize>(
                $"""
                SELECT n.nspname AS "Schema", c.relname AS "Name", pg_total_relation_size(c.oid) AS "Bytes"
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY({names})
                ORDER BY 3 DESC, 1, 2
                LIMIT {take}
                """)
            .ToListAsync(cancellationToken);

        return new DatabaseSize(total, tables);
    }
}
