using Npgsql;

namespace UniOver.IntegrationTests.Guards;

/// <summary>
/// As consultas da regra de fronteira entre schemas. Ficam num lugar só para o teste real e o teste de
/// "mutação" (que prova que elas detectam o problema) usarem exatamente o mesmo SQL.
/// </summary>
internal static class SchemaGuardQueries
{
    /// <summary>Chave estrangeira cuja tabela de origem e de destino estão em schemas diferentes.</summary>
    public const string CrossSchemaForeignKeys = """
        SELECT cn.nspname || '.' || cl.relname || ' -> ' || fn.nspname || '.' || fl.relname
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace cn ON cn.oid = cl.relnamespace
        JOIN pg_class fl ON fl.oid = c.confrelid
        JOIN pg_namespace fn ON fn.oid = fl.relnamespace
        WHERE c.contype = 'f' AND cn.oid <> fn.oid
        ORDER BY 1
        """;

    /// <summary>
    /// View (ou view materializada) que lê relação de outro schema, pelas dependências do rewrite. Os schemas do
    /// próprio Postgres ficam de fora: qualquer outro schema do banco é de módulo.
    /// </summary>
    public const string CrossSchemaViews = """
        SELECT DISTINCT vn.nspname || '.' || v.relname || ' -> ' || tn.nspname || '.' || t.relname
        FROM pg_rewrite r
        JOIN pg_class v ON v.oid = r.ev_class AND v.relkind IN ('v', 'm')
        JOIN pg_namespace vn ON vn.oid = v.relnamespace
        JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
            AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> v.oid
        JOIN pg_class t ON t.oid = d.refobjid
        JOIN pg_namespace tn ON tn.oid = t.relnamespace
        WHERE tn.oid <> vn.oid
          AND vn.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND tn.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY 1
        """;

    /// <summary>Tabela ou view de usuário em <c>public</c> (nada de módulo pode cair lá).</summary>
    public const string PublicObjects = """
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ORDER BY 1
        """;

    /// <summary>Dos schemas informados, os que não têm a tabela de histórico de migrations.</summary>
    public const string SchemasWithoutHistory = """
        SELECT s
        FROM unnest(@schemas) AS s
        WHERE NOT EXISTS (
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = s AND c.relname = '__ef_migrations_history' AND c.relkind = 'r')
        ORDER BY 1
        """;

    public static async Task<List<string>> RunAsync(
        string connection,
        string sql,
        CancellationToken ct,
        string[]? schemas = null)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync(ct);
        await using var command = new NpgsqlCommand(sql, conn);
        if (schemas is not null)
        {
            command.Parameters.AddWithValue("schemas", schemas);
        }

        await using var reader = await command.ExecuteReaderAsync(ct);
        var rows = new List<string>();
        while (await reader.ReadAsync(ct))
        {
            rows.Add(reader.GetString(0));
        }

        return rows;
    }

    public static async Task ExecuteAsync(string connection, string sql, CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync(ct);
        await using var command = new NpgsqlCommand(sql, conn);
        await command.ExecuteNonQueryAsync(ct);
    }
}
