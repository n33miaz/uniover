using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTvMembershipsAndOwnership : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_shortcuts_package",
                schema: "tv",
                table: "shortcuts");

            migrationBuilder.AddColumn<Guid>(
                name: "tv_id",
                schema: "tv",
                table: "shortcuts",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "tv_id",
                schema: "tv",
                table: "command_audit",
                type: "uuid",
                nullable: true);

            // Antes de existir mais de uma TV, toda linha pertencia implicitamente à padrão. O backfill explícito evita
            // que atalhos e auditoria antigos apareçam para uma TV criada depois desta migration.
            migrationBuilder.Sql("UPDATE tv.shortcuts SET tv_id = (SELECT id FROM tv.tvs WHERE is_default) WHERE tv_id IS NULL;");
            migrationBuilder.Sql("UPDATE tv.command_audit SET tv_id = (SELECT id FROM tv.tvs WHERE is_default) WHERE tv_id IS NULL;");

            migrationBuilder.AlterColumn<Guid>(
                name: "tv_id",
                schema: "tv",
                table: "shortcuts",
                type: "uuid",
                nullable: false,
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            migrationBuilder.AlterColumn<Guid>(
                name: "tv_id",
                schema: "tv",
                table: "command_audit",
                type: "uuid",
                nullable: false,
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            migrationBuilder.CreateTable(
                name: "tv_members",
                schema: "tv",
                columns: table => new
                {
                    tv_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    added_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_tv_members", x => new { x.tv_id, x.user_id });
                });

            migrationBuilder.CreateIndex(
                name: "ix_tvs_agent_slug",
                schema: "tv",
                table: "tvs",
                column: "agent_slug",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_shortcuts_tv_id_package",
                schema: "tv",
                table: "shortcuts",
                columns: new[] { "tv_id", "package" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_command_audit_tv_id_occurred_at",
                schema: "tv",
                table: "command_audit",
                columns: new[] { "tv_id", "occurred_at" });

            migrationBuilder.CreateIndex(
                name: "ix_tv_members_user_id",
                schema: "tv",
                table: "tv_members",
                column: "user_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "tv_members",
                schema: "tv");

            migrationBuilder.DropIndex(
                name: "ix_tvs_agent_slug",
                schema: "tv",
                table: "tvs");

            migrationBuilder.DropIndex(
                name: "ix_shortcuts_tv_id_package",
                schema: "tv",
                table: "shortcuts");

            migrationBuilder.DropIndex(
                name: "ix_command_audit_tv_id_occurred_at",
                schema: "tv",
                table: "command_audit");

            migrationBuilder.DropColumn(
                name: "tv_id",
                schema: "tv",
                table: "shortcuts");

            migrationBuilder.DropColumn(
                name: "tv_id",
                schema: "tv",
                table: "command_audit");

            migrationBuilder.CreateIndex(
                name: "ix_shortcuts_package",
                schema: "tv",
                table: "shortcuts",
                column: "package",
                unique: true);
        }
    }
}
