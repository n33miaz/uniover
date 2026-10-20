using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddGuestRoleAndInvites : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "disabled_at",
                schema: "identity",
                table: "users",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "role",
                schema: "identity",
                table: "users",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "owner");

            migrationBuilder.CreateTable(
                name: "guest_invites",
                schema: "identity",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    token_hash = table.Column<byte[]>(type: "bytea", nullable: false),
                    role = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    label = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    used_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    used_by = table.Column<Guid>(type: "uuid", nullable: true),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_guest_invites", x => x.id);
                });

            migrationBuilder.AddCheckConstraint(
                name: "ck_users_role",
                schema: "identity",
                table: "users",
                sql: "role IN ('owner', 'guest')");

            migrationBuilder.CreateIndex(
                name: "ix_guest_invites_created_by",
                schema: "identity",
                table: "guest_invites",
                column: "created_by");

            migrationBuilder.CreateIndex(
                name: "ix_guest_invites_token_hash",
                schema: "identity",
                table: "guest_invites",
                column: "token_hash",
                unique: true);

            // Tabela nova: o papel runtime precisa de DML nela (repete a concessão, que é idempotente). A coluna nova de
            // users herda os privilégios da tabela, e o padrão `owner` mantém a linha do dono e o código antigo funcionando.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("identity"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "guest_invites",
                schema: "identity");

            migrationBuilder.DropCheckConstraint(
                name: "ck_users_role",
                schema: "identity",
                table: "users");

            migrationBuilder.DropColumn(
                name: "disabled_at",
                schema: "identity",
                table: "users");

            migrationBuilder.DropColumn(
                name: "role",
                schema: "identity",
                table: "users");
        }
    }
}
