using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddRefreshRecovery : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "recovered_at",
                schema: "identity",
                table: "refresh_tokens",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "refresh_device_keys",
                schema: "identity",
                columns: table => new
                {
                    family_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    public_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_refresh_device_keys", x => x.family_id);
                    table.ForeignKey(
                        name: "fk_refresh_device_keys_users_user_id",
                        column: x => x.user_id,
                        principalSchema: "identity",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "refresh_recovery_challenges",
                schema: "identity",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    family_id = table.Column<Guid>(type: "uuid", nullable: false),
                    token_id = table.Column<Guid>(type: "uuid", nullable: false),
                    nonce_hash = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    consumed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_refresh_recovery_challenges", x => x.id);
                    table.ForeignKey(
                        name: "fk_refresh_recovery_challenges_refresh_tokens_token_id",
                        column: x => x.token_id,
                        principalSchema: "identity",
                        principalTable: "refresh_tokens",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_refresh_device_keys_user_id",
                schema: "identity",
                table: "refresh_device_keys",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_refresh_recovery_challenges_expires_at",
                schema: "identity",
                table: "refresh_recovery_challenges",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_refresh_recovery_challenges_family_id",
                schema: "identity",
                table: "refresh_recovery_challenges",
                column: "family_id");

            migrationBuilder.CreateIndex(
                name: "ix_refresh_recovery_challenges_token_id",
                schema: "identity",
                table: "refresh_recovery_challenges",
                column: "token_id");

            // Tabelas novas: o papel runtime precisa de DML nelas (a concessão é idempotente e não toca o que já existe).
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("identity"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "refresh_device_keys",
                schema: "identity");

            migrationBuilder.DropTable(
                name: "refresh_recovery_challenges",
                schema: "identity");

            migrationBuilder.DropColumn(
                name: "recovered_at",
                schema: "identity",
                table: "refresh_tokens");
        }
    }
}
