using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Tv.Persistence;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    [DbContext(typeof(TvDbContext))]
    [Migration("20261104090000_AddTvRemovalAudit")]
    public partial class AddTvRemovalAudit : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "tv_removal_audit",
                schema: "tv",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tv_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_id = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    kind = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    ip = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    user_agent = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_tv_removal_audit", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_tv_removal_audit_occurred_at",
                schema: "tv",
                table: "tv_removal_audit",
                column: "occurred_at");

            migrationBuilder.CreateIndex(
                name: "ix_tv_removal_audit_user_id",
                schema: "tv",
                table: "tv_removal_audit",
                column: "user_id");

            // A aplicação só lê e inclui nesse registro (a tabela está em AppendOnlyTables). A linha da remoção fica para
            // sempre, mas o IP e o aparelho de quem removeu são dado pessoal e seguem o prazo das trilhas de segurança.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("tv"));

            // Passado o prazo, esta função apaga SÓ o IP e o aparelho (a linha, o autor e a data permanecem). Mesma forma
            // da purge_audit: SECURITY DEFINER (o papel da aplicação não tem UPDATE), piso de 180 dias escrito aqui dentro
            // (nenhum argumento o reduz), search_path fixo e nomes qualificados. Devolve quantas linhas limpou.
            migrationBuilder.Sql(
                """
                CREATE OR REPLACE FUNCTION "tv"."scrub_removal_audit"(retain_days integer)
                RETURNS bigint
                LANGUAGE plpgsql
                SECURITY DEFINER
                SET search_path = pg_catalog, "tv", pg_temp
                AS $fn$
                DECLARE
                  floor_days CONSTANT integer := 180;
                  keep_days integer := LEAST(GREATEST(COALESCE(retain_days, floor_days), floor_days), 36500);
                  scrubbed bigint;
                BEGIN
                  UPDATE "tv"."tv_removal_audit"
                  SET ip = NULL, user_agent = NULL
                  WHERE occurred_at < now() - make_interval(days => keep_days)
                    AND (ip IS NOT NULL OR user_agent IS NOT NULL);
                  GET DIAGNOSTICS scrubbed = ROW_COUNT;
                  RETURN scrubbed;
                END
                $fn$;

                REVOKE ALL ON FUNCTION "tv"."scrub_removal_audit"(integer) FROM PUBLIC;
                """);

            migrationBuilder.Sql(RuntimeRoleGrants.GrantExecuteSql("tv", "scrub_removal_audit"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP FUNCTION IF EXISTS \"tv\".\"scrub_removal_audit\"(integer);");

            migrationBuilder.DropTable(
                name: "tv_removal_audit",
                schema: "tv");
        }
    }
}
