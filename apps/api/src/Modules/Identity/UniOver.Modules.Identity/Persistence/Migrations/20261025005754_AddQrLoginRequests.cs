using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddQrLoginRequests : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "qr_login_requests",
                schema: "identity",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    code_hash = table.Column<byte[]>(type: "bytea", nullable: false),
                    poll_secret_hash = table.Column<byte[]>(type: "bytea", nullable: false),
                    requester_ip = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    requester_user_agent = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    approved_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    approved_by = table.Column<Guid>(type: "uuid", nullable: true),
                    approver_ip = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    approver_user_agent = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    denied_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    consumed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_qr_login_requests", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_qr_login_requests_code_hash",
                schema: "identity",
                table: "qr_login_requests",
                column: "code_hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_qr_login_requests_expires_at",
                schema: "identity",
                table: "qr_login_requests",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_qr_login_requests_poll_secret_hash",
                schema: "identity",
                table: "qr_login_requests",
                column: "poll_secret_hash",
                unique: true);

            // Tabela nova: o papel runtime precisa de DML nela (a concessão é idempotente e não toca o que já existe).
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("identity"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "qr_login_requests",
                schema: "identity");
        }
    }
}
