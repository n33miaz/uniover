using System;
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "training");

            migrationBuilder.CreateTable(
                name: "catalog_meta",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<int>(type: "integer", nullable: false),
                    seed_version = table.Column<int>(type: "integer", nullable: false),
                    seeded_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_catalog_meta", x => x.id);
                    table.CheckConstraint("ck_catalog_meta_single_row", "id = 1");
                });

            migrationBuilder.CreateTable(
                name: "exercises",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    slug = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    source = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    source_ref = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    instructions = table.Column<List<string>>(type: "text[]", nullable: false),
                    primary_muscles = table.Column<List<string>>(type: "text[]", nullable: false),
                    secondary_muscles = table.Column<List<string>>(type: "text[]", nullable: false),
                    equipment = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    record_type = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    step_kg = table.Column<decimal>(type: "numeric(6,2)", precision: 6, scale: 2, nullable: true),
                    level = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    category = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    mechanic = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    license = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    license_author = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    license_url = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    reviewed = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    owner_user_id = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_exercises", x => x.id);
                    table.CheckConstraint("ck_exercises_record_type", "record_type IN ('weight_reps', 'reps_only', 'time')");
                    table.CheckConstraint("ck_exercises_source", "source IN ('free_exercise_db', 'wger', 'own')");
                });

            migrationBuilder.CreateTable(
                name: "idempotency_keys",
                schema: "training",
                columns: table => new
                {
                    key = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    route = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    request_hash = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: false),
                    status_code = table.Column<int>(type: "integer", nullable: true),
                    response_body = table.Column<string>(type: "text", nullable: true),
                    content_type = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    location = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_idempotency_keys", x => new { x.user_id, x.key });
                });

            migrationBuilder.CreateTable(
                name: "exercise_overrides",
                schema: "training",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    exercise_id = table.Column<Guid>(type: "uuid", nullable: false),
                    step_kg = table.Column<decimal>(type: "numeric(6,2)", precision: 6, scale: 2, nullable: true),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_exercise_overrides", x => new { x.user_id, x.exercise_id });
                    table.ForeignKey(
                        name: "fk_exercise_overrides_exercises_exercise_id",
                        column: x => x.exercise_id,
                        principalSchema: "training",
                        principalTable: "exercises",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_exercise_overrides_exercise_id",
                schema: "training",
                table: "exercise_overrides",
                column: "exercise_id");

            migrationBuilder.CreateIndex(
                name: "ix_exercise_overrides_updated_at_exercise_id",
                schema: "training",
                table: "exercise_overrides",
                columns: new[] { "updated_at", "exercise_id" });

            migrationBuilder.CreateIndex(
                name: "ix_exercises_owner_user_id",
                schema: "training",
                table: "exercises",
                column: "owner_user_id");

            migrationBuilder.CreateIndex(
                name: "ix_exercises_source_slug",
                schema: "training",
                table: "exercises",
                columns: new[] { "source", "slug" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_exercises_source_source_ref",
                schema: "training",
                table: "exercises",
                columns: new[] { "source", "source_ref" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_exercises_updated_at_id",
                schema: "training",
                table: "exercises",
                columns: new[] { "updated_at", "id" });

            migrationBuilder.CreateIndex(
                name: "ix_idempotency_keys_expires_at",
                schema: "training",
                table: "idempotency_keys",
                column: "expires_at");

            // Permissões do papel runtime (só DML); o papel é lido da variável de ambiente ao aplicar.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "catalog_meta",
                schema: "training");

            migrationBuilder.DropTable(
                name: "exercise_overrides",
                schema: "training");

            migrationBuilder.DropTable(
                name: "idempotency_keys",
                schema: "training");

            migrationBuilder.DropTable(
                name: "exercises",
                schema: "training");
        }
    }
}
