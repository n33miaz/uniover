using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAuditAppendOnlyAndRetention : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 1) O papel da aplicação passa a só LER e INCLUIR em login_audit: o auxiliar de permissões (que toda migration de
            //    tabela chama) agora tira UPDATE, DELETE e TRUNCATE das tabelas de auditoria DEPOIS de conceder o DML do
            //    schema, então esta e qualquer migration futura chegam ao mesmo resultado, em qualquer ordem.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("identity"));

            // 2) Quem apaga o que passou do prazo é esta função, e não a aplicação. SECURITY DEFINER: roda com os direitos
            //    do dono da função (o papel das migrations), que é o único com DELETE na tabela. O PISO de 180 dias vive aqui
            //    dentro: qualquer que seja o argumento (zero, negativo, nulo), nada com menos que isso é apagado, então uma
            //    sessão roubada da aplicação não consegue chamar a função para apagar o recente nem encurtar o prazo. Só
            //    estender é possível; encurtar é uma migration nova. O teto de 36500 dias só evita estouro de intervalo.
            //    search_path fixo (pg_temp por último) e nomes qualificados: nenhum objeto temporário ou de outro schema
            //    consegue tomar o lugar do que a função usa. O texto fica escrito aqui, e não gerado por código, para uma
            //    migration aplicada nunca mudar quando o código mudar.
            migrationBuilder.Sql(
                """
                CREATE OR REPLACE FUNCTION "identity"."purge_audit"(retain_days integer)
                RETURNS bigint
                LANGUAGE plpgsql
                SECURITY DEFINER
                SET search_path = pg_catalog, "identity", pg_temp
                AS $fn$
                DECLARE
                  floor_days CONSTANT integer := 180;
                  keep_days integer := LEAST(GREATEST(COALESCE(retain_days, floor_days), floor_days), 36500);
                  removed bigint;
                BEGIN
                  DELETE FROM "identity"."login_audit"
                  WHERE occurred_at < now() - make_interval(days => keep_days);
                  GET DIAGNOSTICS removed = ROW_COUNT;
                  RETURN removed;
                END
                $fn$;

                REVOKE ALL ON FUNCTION "identity"."purge_audit"(integer) FROM PUBLIC;
                """);

            // 3) Só o papel da aplicação executa a função (a migration acima a fechou para todos os outros).
            migrationBuilder.Sql(RuntimeRoleGrants.GrantExecuteSql("identity", "purge_audit"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Desfaz só a função. Devolver UPDATE/DELETE ao papel da aplicação seria desfazer a garantia de só inclusão e
            // não é feito aqui: quem precisar, com o papel dono, concede à mão.
            migrationBuilder.Sql("DROP FUNCTION IF EXISTS \"identity\".\"purge_audit\"(integer);");
        }
    }
}
