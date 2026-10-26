using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTvPowerSchedules : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "power_schedules",
                schema: "tv",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tv_id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_slug = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    requested_by = table.Column<Guid>(type: "uuid", nullable: false),
                    requested_as_owner = table.Column<bool>(type: "boolean", nullable: false),
                    due_at_utc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    time_zone = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    result = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: true),
                    reason = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    version = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    lease_until = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_power_schedules", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_power_schedules_status_due_at_utc",
                schema: "tv",
                table: "power_schedules",
                columns: new[] { "status", "due_at_utc" });

            migrationBuilder.CreateIndex(
                name: "ix_power_schedules_tv_id",
                schema: "tv",
                table: "power_schedules",
                column: "tv_id",
                unique: true,
                filter: "status IN ('pending', 'dispatching')");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "power_schedules",
                schema: "tv");
        }
    }
}
