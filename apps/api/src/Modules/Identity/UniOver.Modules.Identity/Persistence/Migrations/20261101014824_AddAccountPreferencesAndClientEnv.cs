using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAccountPreferencesAndClientEnv : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "client_installed",
                schema: "identity",
                table: "refresh_tokens",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "client_platform",
                schema: "identity",
                table: "refresh_tokens",
                type: "character varying(10)",
                maxLength: 10,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "account_preferences",
                schema: "identity",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    home_json = table.Column<string>(type: "jsonb", nullable: true),
                    version = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_account_preferences", x => x.user_id);
                    table.ForeignKey(
                        name: "fk_account_preferences_users_user_id",
                        column: x => x.user_id,
                        principalSchema: "identity",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            // Tabela nova: o papel runtime precisa de DML nela (a concessao e idempotente e nao toca o que ja existe).
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("identity"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "account_preferences",
                schema: "identity");

            migrationBuilder.DropColumn(
                name: "client_installed",
                schema: "identity",
                table: "refresh_tokens");

            migrationBuilder.DropColumn(
                name: "client_platform",
                schema: "identity",
                table: "refresh_tokens");
        }
    }
}
