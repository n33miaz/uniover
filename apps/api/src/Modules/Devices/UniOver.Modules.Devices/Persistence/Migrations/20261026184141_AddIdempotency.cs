using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Devices.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddIdempotency : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "idempotency_keys",
                schema: "devices",
                columns: table => new
                {
                    key = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    route = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    request_hash = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: false),
                    generation = table.Column<Guid>(type: "uuid", nullable: false, defaultValueSql: "gen_random_uuid()"),
                    status_code = table.Column<int>(type: "integer", nullable: true),
                    response_body = table.Column<string>(type: "text", nullable: true),
                    content_type = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    location = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_idempotency_keys", x => new { x.user_id, x.key });
                });

            migrationBuilder.CreateIndex(
                name: "ix_idempotency_keys_expires_at",
                schema: "devices",
                table: "idempotency_keys",
                column: "expires_at");

            // Tabela nova: o papel runtime precisa de DML nela (a concessão é idempotente e não toca o que já existe).
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("devices"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "idempotency_keys",
                schema: "devices");
        }
    }
}
