using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Devices.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentDiagnostics : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "agent_diagnostic_events",
                schema: "devices",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_id = table.Column<Guid>(type: "uuid", nullable: false),
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    received_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    kind = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: false),
                    severity = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    component = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    detail = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    count = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_diagnostic_events", x => x.id);
                    table.ForeignKey(
                        name: "fk_agent_diagnostic_events_agents_agent_id",
                        column: x => x.agent_id,
                        principalSchema: "devices",
                        principalTable: "agents",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_agent_diagnostic_events_agent_id_at",
                schema: "devices",
                table: "agent_diagnostic_events",
                columns: new[] { "agent_id", "at" });

            migrationBuilder.CreateIndex(
                name: "ix_agent_diagnostic_events_agent_id_event_id",
                schema: "devices",
                table: "agent_diagnostic_events",
                columns: new[] { "agent_id", "event_id" },
                unique: true);

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("devices"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "agent_diagnostic_events",
                schema: "devices");
        }
    }
}
