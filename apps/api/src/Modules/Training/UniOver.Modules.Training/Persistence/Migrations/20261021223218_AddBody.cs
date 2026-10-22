using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddBody : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "body_entries",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    measured_on = table.Column<DateOnly>(type: "date", nullable: false),
                    weight_kg = table.Column<decimal>(type: "numeric(5,2)", precision: 5, scale: 2, nullable: true),
                    body_fat_pct = table.Column<decimal>(type: "numeric(4,1)", precision: 4, scale: 1, nullable: true),
                    fat_method = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: true),
                    waist_cm = table.Column<decimal>(type: "numeric(4,1)", precision: 4, scale: 1, nullable: true),
                    neck_cm = table.Column<decimal>(type: "numeric(4,1)", precision: 4, scale: 1, nullable: true),
                    hip_cm = table.Column<decimal>(type: "numeric(4,1)", precision: 4, scale: 1, nullable: true),
                    arm_cm = table.Column<decimal>(type: "numeric(4,1)", precision: 4, scale: 1, nullable: true),
                    thigh_cm = table.Column<decimal>(type: "numeric(4,1)", precision: 4, scale: 1, nullable: true),
                    note = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_body_entries", x => x.id);
                    table.CheckConstraint("ck_body_entries_arm", "arm_cm IS NULL OR arm_cm BETWEEN 10 AND 250");
                    table.CheckConstraint("ck_body_entries_body_fat", "body_fat_pct IS NULL OR body_fat_pct BETWEEN 2 AND 70");
                    table.CheckConstraint("ck_body_entries_fat_method", "fat_method IS NULL OR fat_method IN ('navy', 'manual', 'bioimpedance')");
                    table.CheckConstraint("ck_body_entries_fat_pair", "(body_fat_pct IS NULL) = (fat_method IS NULL)");
                    table.CheckConstraint("ck_body_entries_hip", "hip_cm IS NULL OR hip_cm BETWEEN 10 AND 250");
                    table.CheckConstraint("ck_body_entries_measured_on", "measured_on >= DATE '1900-01-01'");
                    table.CheckConstraint("ck_body_entries_neck", "neck_cm IS NULL OR neck_cm BETWEEN 10 AND 250");
                    table.CheckConstraint("ck_body_entries_not_empty", "(weight_kg IS NOT NULL OR body_fat_pct IS NOT NULL OR waist_cm IS NOT NULL OR neck_cm IS NOT NULL OR hip_cm IS NOT NULL OR arm_cm IS NOT NULL OR thigh_cm IS NOT NULL) OR deleted_at IS NOT NULL");
                    table.CheckConstraint("ck_body_entries_note", "note IS NULL OR char_length(note) <= 300");
                    table.CheckConstraint("ck_body_entries_thigh", "thigh_cm IS NULL OR thigh_cm BETWEEN 10 AND 250");
                    table.CheckConstraint("ck_body_entries_waist", "waist_cm IS NULL OR waist_cm BETWEEN 10 AND 250");
                    table.CheckConstraint("ck_body_entries_weight", "weight_kg IS NULL OR weight_kg BETWEEN 20 AND 400");
                });

            migrationBuilder.CreateTable(
                name: "body_profile",
                schema: "training",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    height_cm = table.Column<decimal>(type: "numeric(4,1)", precision: 4, scale: 1, nullable: false),
                    birth_date = table.Column<DateOnly>(type: "date", nullable: false),
                    sex = table.Column<string>(type: "character varying(6)", maxLength: 6, nullable: false),
                    activity_factor = table.Column<decimal>(type: "numeric(3,2)", precision: 3, scale: 2, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_body_profile", x => x.user_id);
                    table.CheckConstraint("ck_body_profile_activity", "activity_factor BETWEEN 1.0 AND 2.5");
                    table.CheckConstraint("ck_body_profile_birth_date", "birth_date >= DATE '1900-01-01'");
                    table.CheckConstraint("ck_body_profile_height", "height_cm BETWEEN 100 AND 250");
                    table.CheckConstraint("ck_body_profile_sex", "sex IN ('male', 'female')");
                });

            migrationBuilder.CreateIndex(
                name: "ix_body_entries_user_id_measured_on",
                schema: "training",
                table: "body_entries",
                columns: new[] { "user_id", "measured_on" });

            migrationBuilder.CreateIndex(
                name: "ix_body_entries_user_id_updated_at_id",
                schema: "training",
                table: "body_entries",
                columns: new[] { "user_id", "updated_at", "id" });

            // As tabelas novas precisam das permissões do papel runtime (só DML). O padrão de privilégios da primeira
            // migration já cobre quem as cria, mas repetir é inofensivo e não depende de qual papel aplicou cada migration.
            // A migration só acrescenta tabelas: o código antigo, que roda por alguns minutos sobre o schema novo, não as conhece.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "body_entries",
                schema: "training");

            migrationBuilder.DropTable(
                name: "body_profile",
                schema: "training");
        }
    }
}
