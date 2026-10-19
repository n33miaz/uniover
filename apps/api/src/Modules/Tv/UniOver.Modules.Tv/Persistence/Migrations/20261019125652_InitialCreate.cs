using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "tv");

            migrationBuilder.CreateTable(
                name: "command_audit",
                schema: "tv",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_id = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    command = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    detail = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    ok = table.Column<bool>(type: "boolean", nullable: false),
                    error_code = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    latency_ms = table.Column<int>(type: "integer", nullable: true),
                    ip = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    user_agent = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_command_audit", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "dead_letters",
                schema: "tv",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    type = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    payload = table.Column<string>(type: "jsonb", nullable: false),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    failed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    attempts = table.Column<int>(type: "integer", nullable: false),
                    last_error = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_dead_letters", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "outbox_messages",
                schema: "tv",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    type = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    payload = table.Column<string>(type: "jsonb", nullable: false),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    attempts = table.Column<int>(type: "integer", nullable: false),
                    next_attempt_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    processed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    last_error = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_outbox_messages", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "shortcuts",
                schema: "tv",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    package = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    tv_label = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    custom_label = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    position = table.Column<int>(type: "integer", nullable: false),
                    enabled = table.Column<bool>(type: "boolean", nullable: false),
                    installed = table.Column<bool>(type: "boolean", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_shortcuts", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "tv_state",
                schema: "tv",
                columns: table => new
                {
                    agent_id = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    power = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    app = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    connection = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_tv_state", x => x.agent_id);
                });

            migrationBuilder.CreateTable(
                name: "watchdog_events",
                schema: "tv",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_id = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    kind = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    severity = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    detail = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    attempts = table.Column<int>(type: "integer", nullable: false),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    received_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_watchdog_events", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_command_audit_occurred_at",
                schema: "tv",
                table: "command_audit",
                column: "occurred_at");

            migrationBuilder.CreateIndex(
                name: "ix_outbox_messages_pending",
                schema: "tv",
                table: "outbox_messages",
                column: "next_attempt_at",
                filter: "processed_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_shortcuts_package",
                schema: "tv",
                table: "shortcuts",
                column: "package",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_shortcuts_position",
                schema: "tv",
                table: "shortcuts",
                column: "position");

            migrationBuilder.CreateIndex(
                name: "ix_watchdog_events_occurred_at",
                schema: "tv",
                table: "watchdog_events",
                column: "occurred_at");

            // Permissões do papel runtime (só DML); o papel é lido da variável de ambiente ao aplicar.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("tv"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "command_audit",
                schema: "tv");

            migrationBuilder.DropTable(
                name: "dead_letters",
                schema: "tv");

            migrationBuilder.DropTable(
                name: "outbox_messages",
                schema: "tv");

            migrationBuilder.DropTable(
                name: "shortcuts",
                schema: "tv");

            migrationBuilder.DropTable(
                name: "tv_state",
                schema: "tv");

            migrationBuilder.DropTable(
                name: "watchdog_events",
                schema: "tv");
        }
    }
}
