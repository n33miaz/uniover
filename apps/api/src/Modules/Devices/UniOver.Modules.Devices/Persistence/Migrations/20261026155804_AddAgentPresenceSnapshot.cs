using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Devices.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentPresenceSnapshot : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "agent_presence_snapshots",
                schema: "devices",
                columns: table => new
                {
                    agent_id = table.Column<Guid>(type: "uuid", nullable: false),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    agent_version = table.Column<string>(type: "text", nullable: true),
                    os = table.Column<string>(type: "text", nullable: true),
                    tv_kind = table.Column<string>(type: "text", nullable: true),
                    tv_host = table.Column<string>(type: "text", nullable: true),
                    update_outcome = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    installed_sha = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    installed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    latest_sha = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    checked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    next_check_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    update_reason = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    blocked_sha = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    previous_sha = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    rolled_back = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_presence_snapshots", x => x.agent_id);
                    table.ForeignKey(
                        name: "fk_agent_presence_snapshots_agents_agent_id",
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
                name: "agent_presence_snapshots",
                schema: "devices");
        }
    }
}
