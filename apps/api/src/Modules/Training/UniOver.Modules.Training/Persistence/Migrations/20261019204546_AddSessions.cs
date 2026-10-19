using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddSessions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "sessions",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    routine_id = table.Column<Guid>(type: "uuid", nullable: true),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    finished_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    note = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    feeling = table.Column<int>(type: "integer", nullable: true),
                    device_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_sessions", x => x.id);
                    table.CheckConstraint("ck_sessions_device", "char_length(device_id) BETWEEN 1 AND 64");
                    table.CheckConstraint("ck_sessions_feeling", "feeling IS NULL OR feeling BETWEEN 1 AND 5");
                    table.CheckConstraint("ck_sessions_finish", "finished_at IS NULL OR finished_at >= started_at");
                    table.CheckConstraint("ck_sessions_note", "note IS NULL OR char_length(note) <= 500");
                    table.ForeignKey(
                        name: "fk_sessions_routines_routine_id",
                        column: x => x.routine_id,
                        principalSchema: "training",
                        principalTable: "routines",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "session_sets",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    session_id = table.Column<Guid>(type: "uuid", nullable: false),
                    exercise_id = table.Column<Guid>(type: "uuid", nullable: false),
                    position = table.Column<int>(type: "integer", nullable: false),
                    set_type = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    weight_kg = table.Column<decimal>(type: "numeric(7,2)", precision: 7, scale: 2, nullable: true),
                    reps = table.Column<int>(type: "integer", nullable: true),
                    duration_s = table.Column<int>(type: "integer", nullable: true),
                    rir = table.Column<int>(type: "integer", nullable: true),
                    rpe = table.Column<decimal>(type: "numeric(3,1)", precision: 3, scale: 1, nullable: true),
                    note = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_session_sets", x => x.id);
                    table.CheckConstraint("ck_session_sets_duration", "duration_s IS NULL OR duration_s BETWEEN 0 AND 86400");
                    table.CheckConstraint("ck_session_sets_note", "note IS NULL OR char_length(note) <= 300");
                    table.CheckConstraint("ck_session_sets_position", "position BETWEEN 0 AND 100000");
                    table.CheckConstraint("ck_session_sets_reps", "reps IS NULL OR reps BETWEEN 0 AND 999");
                    table.CheckConstraint("ck_session_sets_rir", "rir IS NULL OR rir BETWEEN 0 AND 10");
                    table.CheckConstraint("ck_session_sets_rpe", "rpe IS NULL OR (rpe BETWEEN 1 AND 10 AND rpe * 2 = trunc(rpe * 2))");
                    table.CheckConstraint("ck_session_sets_type", "set_type IN ('warmup', 'work', 'failure', 'drop')");
                    table.CheckConstraint("ck_session_sets_weight", "weight_kg IS NULL OR weight_kg >= 0");
                    table.ForeignKey(
                        name: "fk_session_sets_exercises_exercise_id",
                        column: x => x.exercise_id,
                        principalSchema: "training",
                        principalTable: "exercises",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_session_sets_sessions_session_id",
                        column: x => x.session_id,
                        principalSchema: "training",
                        principalTable: "sessions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_session_sets_exercise_id",
                schema: "training",
                table: "session_sets",
                column: "exercise_id");

            migrationBuilder.CreateIndex(
                name: "ix_session_sets_session_id",
                schema: "training",
                table: "session_sets",
                column: "session_id");

            migrationBuilder.CreateIndex(
                name: "ix_session_sets_user_id_exercise_id_completed_at",
                schema: "training",
                table: "session_sets",
                columns: new[] { "user_id", "exercise_id", "completed_at" });

            migrationBuilder.CreateIndex(
                name: "ix_session_sets_user_id_updated_at_id",
                schema: "training",
                table: "session_sets",
                columns: new[] { "user_id", "updated_at", "id" });

            migrationBuilder.CreateIndex(
                name: "ix_sessions_routine_id",
                schema: "training",
                table: "sessions",
                column: "routine_id");

            migrationBuilder.CreateIndex(
                name: "ix_sessions_user_id",
                schema: "training",
                table: "sessions",
                column: "user_id",
                unique: true,
                filter: "finished_at IS NULL AND deleted_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_sessions_user_id_updated_at_id",
                schema: "training",
                table: "sessions",
                columns: new[] { "user_id", "updated_at", "id" });

            // As tabelas novas precisam das permissões do papel runtime (só DML). O padrão de privilégios da primeira
            // migration já cobre quem as cria, mas repetir é inofensivo e não depende de qual papel aplicou cada migration.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "session_sets",
                schema: "training");

            migrationBuilder.DropTable(
                name: "sessions",
                schema: "training");
        }
    }
}
