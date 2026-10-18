using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddPasskeysAndStepUp : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "passkeys",
                schema: "identity",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    credential_id = table.Column<byte[]>(type: "bytea", nullable: false),
                    public_key = table.Column<byte[]>(type: "bytea", nullable: false),
                    sign_count = table.Column<long>(type: "bigint", nullable: false),
                    aaguid = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    transports = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_used_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_passkeys", x => x.id);
                    table.ForeignKey(
                        name: "fk_passkeys_users_user_id",
                        column: x => x.user_id,
                        principalSchema: "identity",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "step_up_confirmations",
                schema: "identity",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    session_family_id = table.Column<Guid>(type: "uuid", nullable: false),
                    action = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    confirmed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_step_up_confirmations", x => x.id);
                    table.ForeignKey(
                        name: "fk_step_up_confirmations_users_user_id",
                        column: x => x.user_id,
                        principalSchema: "identity",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "webauthn_challenges",
                schema: "identity",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    purpose = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    action = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    options_json = table.Column<string>(type: "text", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_webauthn_challenges", x => x.id);
                    table.ForeignKey(
                        name: "fk_webauthn_challenges_users_user_id",
                        column: x => x.user_id,
                        principalSchema: "identity",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_passkeys_credential_id",
                schema: "identity",
                table: "passkeys",
                column: "credential_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_passkeys_user_id",
                schema: "identity",
                table: "passkeys",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_step_up_confirmations_expires_at",
                schema: "identity",
                table: "step_up_confirmations",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_step_up_confirmations_session_family_id_action",
                schema: "identity",
                table: "step_up_confirmations",
                columns: new[] { "session_family_id", "action" });

            migrationBuilder.CreateIndex(
                name: "ix_step_up_confirmations_user_id",
                schema: "identity",
                table: "step_up_confirmations",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_webauthn_challenges_expires_at",
                schema: "identity",
                table: "webauthn_challenges",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_webauthn_challenges_user_id",
                schema: "identity",
                table: "webauthn_challenges",
                column: "user_id");

            // Tabelas novas: o papel runtime precisa de DML nelas (repete a concessão, que é idempotente).
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("identity"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "passkeys",
                schema: "identity");

            migrationBuilder.DropTable(
                name: "step_up_confirmations",
                schema: "identity");

            migrationBuilder.DropTable(
                name: "webauthn_challenges",
                schema: "identity");
        }
    }
}
