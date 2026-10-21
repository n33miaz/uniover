namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// SQL de permissões do papel runtime sobre o schema de um módulo: DML sim, DDL nunca (sem <c>CREATE</c>), e nas
/// tabelas de auditoria só inclusão (sem <c>UPDATE</c>, <c>DELETE</c> nem <c>TRUNCATE</c>).
/// Cada módulo chama <c>migrationBuilder.Sql(RuntimeRoleGrants.Sql("schema"))</c> em toda migration que cria tabela.
/// </summary>
public static class RuntimeRoleGrants
{
    public const string RoleVariable = "UNIOVER_RUNTIME_ROLE";
    public const string DefaultRole = "uniover_app";

    /// <summary>
    /// O papel vem da variável de ambiente lida na hora de aplicar a migration (o bundle não tem appsettings).
    /// Identificador SQL não aceita parâmetro; por isso estes são os únicos pontos com SQL de texto montado, e os
    /// valores passam pela mesma validação restrita antes de entrar no texto (coberto por teste).
    /// </summary>
    /// <param name="schema">O schema do módulo.</param>
    /// <param name="appendOnlyTables">
    /// As tabelas desse schema que o papel só pode ler e incluir. Sem este argumento valem as de
    /// <see cref="AppendOnlyTables"/>: é a regra de propósito, para que uma migration futura que chame só
    /// <c>Sql("schema")</c> nunca devolva o <c>DELETE</c> às tabelas de auditoria. A exceção vem DEPOIS dos
    /// <c>GRANT</c> de tabelas (os de <c>ON ALL TABLES</c> e os padrões para tabelas futuras), então vence qualquer ordem.
    /// </param>
    public static string Sql(string schema, IEnumerable<string>? appendOnlyTables = null)
    {
        SchemaName.EnsureValid(schema);

        var role = Role();
        var tables = (appendOnlyTables ?? AppendOnlyTables.Of(schema)).Distinct(StringComparer.Ordinal).ToList();
        foreach (var table in tables)
        {
            SchemaName.EnsureValid(table, "table");
        }

        // `to_regclass` guarda cada REVOKE: uma migration antiga que roda num banco novo chama este auxiliar antes de a
        // tabela existir, e REVOKE numa tabela que não existe é erro.
        var appendOnly = string.Concat(tables.Select(table => $$"""

                IF to_regclass('"{{schema}}"."{{table}}"') IS NOT NULL THEN
                  REVOKE UPDATE, DELETE, TRUNCATE ON "{{schema}}"."{{table}}" FROM "{{role}}";
                END IF;
            """));

        // O bloco só age se o papel existir: em desenvolvimento local sem papel runtime a migration não quebra.
        // A tabela de histórico fica de fora: a aplicação não tem por que alterar o que o EF controla.
        return $$"""
            DO $$
            BEGIN
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{{role}}') THEN
                GRANT USAGE ON SCHEMA "{{schema}}" TO "{{role}}";
                GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "{{schema}}" TO "{{role}}";
                GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "{{schema}}" TO "{{role}}";
                ALTER DEFAULT PRIVILEGES IN SCHEMA "{{schema}}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{{role}}";
                ALTER DEFAULT PRIVILEGES IN SCHEMA "{{schema}}" GRANT USAGE, SELECT ON SEQUENCES TO "{{role}}";
                REVOKE ALL ON "{{schema}}"."__ef_migrations_history" FROM "{{role}}";{{appendOnly}}
              END IF;
            END
            $$;
            """;
    }

    /// <summary>
    /// Deixa o papel runtime EXECUTAR a função <c>schema.function(integer)</c> (as de retenção da auditoria). A função
    /// nasce com <c>EXECUTE</c> para todo mundo (<c>PUBLIC</c>); a migration o retira e este SQL concede só ao papel.
    /// </summary>
    public static string GrantExecuteSql(string schema, string function)
    {
        SchemaName.EnsureValid(schema);
        SchemaName.EnsureValid(function, "function");

        var role = Role();
        return $$"""
            DO $$
            BEGIN
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{{role}}') THEN
                GRANT EXECUTE ON FUNCTION "{{schema}}"."{{function}}"(integer) TO "{{role}}";
              END IF;
            END
            $$;
            """;
    }

    private static string Role()
    {
        var role = Environment.GetEnvironmentVariable(RoleVariable);
        if (string.IsNullOrWhiteSpace(role))
        {
            role = DefaultRole;
        }

        SchemaName.EnsureValid(role, "role");
        return role;
    }
}
