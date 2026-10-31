using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddCalendarEntries : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "calendar_entries",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    day = table.Column<DateOnly>(type: "date", nullable: false),
                    absent = table.Column<bool>(type: "boolean", nullable: false),
                    note = table.Column<string>(type: "character varying(280)", maxLength: 280, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_calendar_entries", x => x.id);
                    table.CheckConstraint("ck_calendar_entries_live", "deleted_at IS NOT NULL OR absent OR note IS NOT NULL");
                    table.CheckConstraint("ck_calendar_entries_note", "note IS NULL OR char_length(note) BETWEEN 1 AND 280");
                });

            migrationBuilder.CreateIndex(
                name: "ix_calendar_entries_user_id_day",
                schema: "training",
                table: "calendar_entries",
                columns: new[] { "user_id", "day" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_calendar_entries_user_id_updated_at_id",
                schema: "training",
                table: "calendar_entries",
                columns: new[] { "user_id", "updated_at", "id" });

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "calendar_entries",
                schema: "training");
        }
    }
}
