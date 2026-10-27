using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Devices.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentOutages : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "agent_outages",
                schema: "devices",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_id = table.Column<Guid>(type: "uuid", nullable: false),
                    detected_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    recovered_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_outages", x => x.id);
                    table.ForeignKey(
                        name: "fk_agent_outages_agents_agent_id",
                        column: x => x.agent_id,
                        principalSchema: "devices",
                        principalTable: "agents",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_agent_outages_detected_at",
                schema: "devices",
                table: "agent_outages",
                column: "detected_at");

            migrationBuilder.CreateIndex(
                name: "ux_agent_outages_open",
                schema: "devices",
                table: "agent_outages",
                column: "agent_id",
                unique: true,
                filter: "recovered_at IS NULL");

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("devices"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "agent_outages",
                schema: "devices");
        }
    }
}
