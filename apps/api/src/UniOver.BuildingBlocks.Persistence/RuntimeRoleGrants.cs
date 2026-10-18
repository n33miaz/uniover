namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// SQL de permissões do papel runtime sobre o schema de um módulo: DML sim, DDL nunca (sem <c>CREATE</c>).
/// Cada módulo chama <c>migrationBuilder.Sql(RuntimeRoleGrants.Sql("schema"))</c> na primeira migration.
/// </summary>
public static class RuntimeRoleGrants
{
    public const string RoleVariable = "UNIOVER_RUNTIME_ROLE";
    public const string DefaultRole = "uniover_app";

    /// <summary>
    /// O papel vem da variável de ambiente lida na hora de aplicar a migration (o bundle não tem appsettings).
    /// Identificador SQL não aceita parâmetro; por isso este é o único ponto com SQL de texto montado, e os dois
    /// valores passam pela mesma validação restrita antes de entrar no texto (coberto por teste).
    /// </summary>
    public static string Sql(string schema)
    {
        SchemaName.EnsureValid(schema);

        var role = Environment.GetEnvironmentVariable(RoleVariable);
        if (string.IsNullOrWhiteSpace(role))
        {
            role = DefaultRole;
        }

        SchemaName.EnsureValid(role, "role");

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
                REVOKE ALL ON "{{schema}}"."__ef_migrations_history" FROM "{{role}}";
              END IF;
            END
            $$;
            """;
    }
}
