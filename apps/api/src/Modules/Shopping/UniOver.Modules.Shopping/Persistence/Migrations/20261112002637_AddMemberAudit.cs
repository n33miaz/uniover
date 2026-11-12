using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Shopping.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddMemberAudit : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "member_audit",
                schema: "shopping",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    @event = table.Column<string>(name: "event", type: "character varying(24)", maxLength: 24, nullable: false),
                    actor_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    target_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_member_audit", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_member_audit_occurred_at_id",
                schema: "shopping",
                table: "member_audit",
                columns: new[] { "occurred_at", "id" });

            // A tabela está em AppendOnlyTables: este grant dá ao papel da aplicação só leitura e inclusão nela
            // (sem UPDATE, DELETE nem TRUNCATE).
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("shopping"));

            // Quem apaga o que passou do prazo é esta função, e não a aplicação. Mesma forma das outras trilhas:
            // SECURITY DEFINER (o papel da aplicação não tem DELETE), piso de 180 dias escrito aqui dentro (nenhum
            // argumento o reduz), search_path fixo e nomes qualificados. Devolve quantas linhas apagou.
            migrationBuilder.Sql(
                """
                CREATE OR REPLACE FUNCTION "shopping"."purge_audit"(retain_days integer)
                RETURNS bigint
                LANGUAGE plpgsql
                SECURITY DEFINER
                SET search_path = pg_catalog, "shopping", pg_temp
                AS $fn$
                DECLARE
                  floor_days CONSTANT integer := 180;
                  keep_days integer := LEAST(GREATEST(COALESCE(retain_days, floor_days), floor_days), 36500);
                  removed bigint;
                BEGIN
                  DELETE FROM "shopping"."member_audit"
                  WHERE occurred_at < now() - make_interval(days => keep_days);
                  GET DIAGNOSTICS removed = ROW_COUNT;
                  RETURN removed;
                END
                $fn$;

                REVOKE ALL ON FUNCTION "shopping"."purge_audit"(integer) FROM PUBLIC;
                """);

            // Só o papel da aplicação executa a função (o trecho acima a fechou para todos os outros).
            migrationBuilder.Sql(RuntimeRoleGrants.GrantExecuteSql("shopping", "purge_audit"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP FUNCTION IF EXISTS \"shopping\".\"purge_audit\"(integer);");

            migrationBuilder.DropTable(
                name: "member_audit",
                schema: "shopping");
        }
    }
}
