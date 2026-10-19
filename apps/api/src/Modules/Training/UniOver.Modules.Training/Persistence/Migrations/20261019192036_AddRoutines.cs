using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddRoutines : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "routines",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    position = table.Column<int>(type: "integer", nullable: false),
                    active = table.Column<bool>(type: "boolean", nullable: false),
                    note = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_routines", x => x.id);
                    table.CheckConstraint("ck_routines_name", "char_length(name) BETWEEN 1 AND 80");
                    table.CheckConstraint("ck_routines_position", "position BETWEEN 0 AND 1000");
                });

            migrationBuilder.CreateTable(
                name: "routine_items",
                schema: "training",
                columns: table => new
                {
                    routine_id = table.Column<Guid>(type: "uuid", nullable: false),
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    exercise_id = table.Column<Guid>(type: "uuid", nullable: false),
                    position = table.Column<int>(type: "integer", nullable: false),
                    target_sets = table.Column<int>(type: "integer", nullable: false),
                    rep_min = table.Column<int>(type: "integer", nullable: false),
                    rep_max = table.Column<int>(type: "integer", nullable: false),
                    rest_seconds = table.Column<int>(type: "integer", nullable: false),
                    superset_group = table.Column<int>(type: "integer", nullable: true),
                    note = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_routine_items", x => new { x.routine_id, x.id });
                    table.CheckConstraint("ck_routine_items_position", "position >= 0");
                    table.CheckConstraint("ck_routine_items_reps", "rep_min BETWEEN 1 AND 100 AND rep_max BETWEEN 1 AND 100 AND rep_min <= rep_max");
                    table.CheckConstraint("ck_routine_items_rest", "rest_seconds BETWEEN 0 AND 1800");
                    table.CheckConstraint("ck_routine_items_sets", "target_sets BETWEEN 1 AND 20");
                    table.CheckConstraint("ck_routine_items_superset", "superset_group IS NULL OR superset_group BETWEEN 1 AND 100");
                    table.ForeignKey(
                        name: "fk_routine_items_exercises_exercise_id",
                        column: x => x.exercise_id,
                        principalSchema: "training",
                        principalTable: "exercises",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_routine_items_routines_routine_id",
                        column: x => x.routine_id,
                        principalSchema: "training",
                        principalTable: "routines",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_routine_items_exercise_id",
                schema: "training",
                table: "routine_items",
                column: "exercise_id");

            migrationBuilder.CreateIndex(
                name: "ix_routines_user_id_updated_at_id",
                schema: "training",
                table: "routines",
                columns: new[] { "user_id", "updated_at", "id" });

            // As tabelas novas precisam das permissões do papel runtime (só DML). O padrão de privilégios da primeira
            // migration já cobre quem as cria, mas repetir é inofensivo e não depende de qual papel aplicou cada migration.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "routine_items",
                schema: "training");

            migrationBuilder.DropTable(
                name: "routines",
                schema: "training");
        }
    }
}
