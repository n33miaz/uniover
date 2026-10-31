using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddCleanupReports : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "allow_background_app_closing",
                schema: "tv",
                table: "tvs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "cleanup_reports",
                schema: "tv",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tv_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    trigger = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    memory_before_mb = table.Column<int>(type: "integer", nullable: true),
                    memory_after_mb = table.Column<int>(type: "integer", nullable: true),
                    closed_apps = table.Column<int>(type: "integer", nullable: false),
                    background_processes = table.Column<int>(type: "integer", nullable: true),
                    session_open_ms = table.Column<int>(type: "integer", nullable: true),
                    apps_closed = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    result = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    reason = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_cleanup_reports", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_cleanup_reports_tv_id_started_at",
                schema: "tv",
                table: "cleanup_reports",
                columns: new[] { "tv_id", "started_at" });

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("tv"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "cleanup_reports",
                schema: "tv");

            migrationBuilder.DropColumn(
                name: "allow_background_app_closing",
                schema: "tv",
                table: "tvs");
        }
    }
}
