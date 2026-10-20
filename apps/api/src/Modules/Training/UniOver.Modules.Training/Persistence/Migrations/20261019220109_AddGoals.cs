using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddGoals : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "goals",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    exercise_id = table.Column<Guid>(type: "uuid", nullable: true),
                    value = table.Column<decimal>(type: "numeric(9,2)", precision: 9, scale: 2, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_goals", x => x.id);
                    table.CheckConstraint("ck_goals_exercise", "(kind = 'exercise_e1rm') = (exercise_id IS NOT NULL)");
                    table.CheckConstraint("ck_goals_kind", "kind IN ('exercise_e1rm', 'weekly_sessions', 'daily_kcal')");
                    table.CheckConstraint("ck_goals_value", "(value IS NOT NULL AND ((kind = 'exercise_e1rm' AND value BETWEEN 1 AND 1000) OR (kind = 'weekly_sessions' AND value BETWEEN 1 AND 14) OR (kind = 'daily_kcal' AND value BETWEEN 500 AND 10000))) OR (value IS NULL AND deleted_at IS NOT NULL)");
                    table.ForeignKey(
                        name: "fk_goals_exercises_exercise_id",
                        column: x => x.exercise_id,
                        principalSchema: "training",
                        principalTable: "exercises",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_goals_exercise_id",
                schema: "training",
                table: "goals",
                column: "exercise_id");

            migrationBuilder.CreateIndex(
                name: "ix_goals_user_id_kind_exercise_id",
                schema: "training",
                table: "goals",
                columns: new[] { "user_id", "kind", "exercise_id" },
                unique: true)
                .Annotation("Npgsql:NullsDistinct", false);

            migrationBuilder.CreateIndex(
                name: "ix_goals_user_id_updated_at_id",
                schema: "training",
                table: "goals",
                columns: new[] { "user_id", "updated_at", "id" });

            // A tabela nova precisa das permissões do papel runtime (só DML). O padrão de privilégios da primeira
            // migration já cobre quem a cria, mas repetir é inofensivo e não depende de qual papel aplicou cada migration.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "goals",
                schema: "training");
        }
    }
}
