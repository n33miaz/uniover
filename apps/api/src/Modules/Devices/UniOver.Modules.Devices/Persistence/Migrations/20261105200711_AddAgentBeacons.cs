using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Devices.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentBeacons : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "agent_beacons",
                schema: "devices",
                columns: table => new
                {
                    agent_id = table.Column<Guid>(type: "uuid", nullable: false),
                    last_stage = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    last_code = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    last_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    first_fail_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    count = table.Column<int>(type: "integer", nullable: false),
                    verified = table.Column<bool>(type: "boolean", nullable: false),
                    version = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    os = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: true),
                    last_reject_reason = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    last_rejected_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_beacons", x => x.agent_id);
                    table.ForeignKey(
                        name: "fk_agent_beacons_agents_agent_id",
                        column: x => x.agent_id,
                        principalSchema: "devices",
                        principalTable: "agents",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("devices"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "agent_beacons",
                schema: "devices");
        }
    }
}
