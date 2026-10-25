using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Training.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations;

[DbContext(typeof(TrainingDbContext))]
[Migration("20261024130000_AddProgressPhotos")]
public sealed class AddProgressPhotos : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "progress_photos", schema: "training",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                user_id = table.Column<Guid>(type: "uuid", nullable: false),
                taken_on = table.Column<DateOnly>(type: "date", nullable: false),
                object_key = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                width = table.Column<int>(type: "integer", nullable: false),
                height = table.Column<int>(type: "integer", nullable: false),
                byte_length = table.Column<long>(type: "bigint", nullable: false),
                sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                state = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
            },
            constraints: table =>
            {
                table.PrimaryKey("pk_progress_photos", x => x.id);
                table.CheckConstraint("ck_progress_photos_bytes", "byte_length BETWEEN 4 AND 5242880");
                table.CheckConstraint("ck_progress_photos_deleted_at", "(state = 'deleted') = (deleted_at IS NOT NULL)");
                table.CheckConstraint("ck_progress_photos_dimensions", "width BETWEEN 1 AND 1280 AND height BETWEEN 1 AND 1280 AND (width::bigint * height) <= 1638400");
                table.CheckConstraint("ck_progress_photos_sha256", "sha256 ~ '^[0-9a-f]{64}$'");
                table.CheckConstraint("ck_progress_photos_state", "state IN ('pending', 'ready', 'deleted')");
            });
        migrationBuilder.CreateIndex(
            name: "ix_progress_photos_object_key", schema: "training", table: "progress_photos", column: "object_key", unique: true);
        migrationBuilder.CreateIndex(
            name: "ix_progress_photos_user_id_taken_on_created_at_id", schema: "training", table: "progress_photos",
            columns: new[] { "user_id", "taken_on", "created_at", "id" }, filter: "state = 'ready'");
        migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable("progress_photos", "training");
    }
}
