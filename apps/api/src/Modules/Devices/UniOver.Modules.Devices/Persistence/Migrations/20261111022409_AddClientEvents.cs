using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Devices.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddClientEvents : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "client_events",
                schema: "devices",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    received_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    module = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: false),
                    code = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: true),
                    status = table.Column<int>(type: "integer", nullable: true),
                    trace_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    transport = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: true),
                    visibility = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    route = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    api = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    version = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    grace = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_client_events", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_client_events_at",
                schema: "devices",
                table: "client_events",
                column: "at");

            migrationBuilder.CreateIndex(
                name: "ix_client_events_event_id",
                schema: "devices",
                table: "client_events",
                column: "event_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_client_events_user_id_at",
                schema: "devices",
                table: "client_events",
                columns: new[] { "user_id", "at" });

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("devices"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "client_events",
                schema: "devices");
        }
    }
}
