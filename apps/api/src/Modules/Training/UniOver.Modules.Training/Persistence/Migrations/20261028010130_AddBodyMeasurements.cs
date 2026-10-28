using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddBodyMeasurements : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_not_empty",
                schema: "training",
                table: "body_entries");

            migrationBuilder.AddColumn<decimal>(
                name: "abdomen_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "abdomen_skinfold_mm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "arm_left_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "arm_right_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "calf_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "calf_left_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "calf_right_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "chest_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "chest_skinfold_mm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "forearm_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "forearm_left_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "forearm_right_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "thigh_left_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "thigh_right_cm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "thigh_skinfold_mm",
                schema: "training",
                table: "body_entries",
                type: "numeric(4,1)",
                precision: 4,
                scale: 1,
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_abdomen",
                schema: "training",
                table: "body_entries",
                sql: "abdomen_cm IS NULL OR abdomen_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_abdomen_skinfold",
                schema: "training",
                table: "body_entries",
                sql: "abdomen_skinfold_mm IS NULL OR abdomen_skinfold_mm BETWEEN 1 AND 100");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_arm_left",
                schema: "training",
                table: "body_entries",
                sql: "arm_left_cm IS NULL OR arm_left_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_arm_right",
                schema: "training",
                table: "body_entries",
                sql: "arm_right_cm IS NULL OR arm_right_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_calf",
                schema: "training",
                table: "body_entries",
                sql: "calf_cm IS NULL OR calf_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_calf_left",
                schema: "training",
                table: "body_entries",
                sql: "calf_left_cm IS NULL OR calf_left_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_calf_right",
                schema: "training",
                table: "body_entries",
                sql: "calf_right_cm IS NULL OR calf_right_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_chest",
                schema: "training",
                table: "body_entries",
                sql: "chest_cm IS NULL OR chest_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_chest_skinfold",
                schema: "training",
                table: "body_entries",
                sql: "chest_skinfold_mm IS NULL OR chest_skinfold_mm BETWEEN 1 AND 100");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_forearm",
                schema: "training",
                table: "body_entries",
                sql: "forearm_cm IS NULL OR forearm_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_forearm_left",
                schema: "training",
                table: "body_entries",
                sql: "forearm_left_cm IS NULL OR forearm_left_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_forearm_right",
                schema: "training",
                table: "body_entries",
                sql: "forearm_right_cm IS NULL OR forearm_right_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_not_empty",
                schema: "training",
                table: "body_entries",
                sql: "(weight_kg IS NOT NULL OR body_fat_pct IS NOT NULL OR waist_cm IS NOT NULL OR neck_cm IS NOT NULL OR hip_cm IS NOT NULL OR arm_cm IS NOT NULL OR thigh_cm IS NOT NULL OR chest_cm IS NOT NULL OR abdomen_cm IS NOT NULL OR forearm_cm IS NOT NULL OR calf_cm IS NOT NULL OR arm_right_cm IS NOT NULL OR arm_left_cm IS NOT NULL OR forearm_right_cm IS NOT NULL OR forearm_left_cm IS NOT NULL OR thigh_right_cm IS NOT NULL OR thigh_left_cm IS NOT NULL OR calf_right_cm IS NOT NULL OR calf_left_cm IS NOT NULL OR chest_skinfold_mm IS NOT NULL OR abdomen_skinfold_mm IS NOT NULL OR thigh_skinfold_mm IS NOT NULL) OR deleted_at IS NOT NULL");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_thigh_left",
                schema: "training",
                table: "body_entries",
                sql: "thigh_left_cm IS NULL OR thigh_left_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_thigh_right",
                schema: "training",
                table: "body_entries",
                sql: "thigh_right_cm IS NULL OR thigh_right_cm BETWEEN 10 AND 250");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_thigh_skinfold",
                schema: "training",
                table: "body_entries",
                sql: "thigh_skinfold_mm IS NULL OR thigh_skinfold_mm BETWEEN 1 AND 100");

            // Mantém as concessões do papel da aplicação em dia, como as demais migrations do módulo.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_abdomen",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_abdomen_skinfold",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_arm_left",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_arm_right",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_calf",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_calf_left",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_calf_right",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_chest",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_chest_skinfold",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_forearm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_forearm_left",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_forearm_right",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_not_empty",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_thigh_left",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_thigh_right",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_body_entries_thigh_skinfold",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "abdomen_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "abdomen_skinfold_mm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "arm_left_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "arm_right_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "calf_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "calf_left_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "calf_right_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "chest_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "chest_skinfold_mm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "forearm_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "forearm_left_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "forearm_right_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "thigh_left_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "thigh_right_cm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.DropColumn(
                name: "thigh_skinfold_mm",
                schema: "training",
                table: "body_entries");

            migrationBuilder.AddCheckConstraint(
                name: "ck_body_entries_not_empty",
                schema: "training",
                table: "body_entries",
                sql: "(weight_kg IS NOT NULL OR body_fat_pct IS NOT NULL OR waist_cm IS NOT NULL OR neck_cm IS NOT NULL OR hip_cm IS NOT NULL OR arm_cm IS NOT NULL OR thigh_cm IS NOT NULL) OR deleted_at IS NOT NULL");
        }
    }
}
