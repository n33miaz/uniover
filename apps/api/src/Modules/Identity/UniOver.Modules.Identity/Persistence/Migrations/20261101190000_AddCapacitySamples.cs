using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddCapacitySamples : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "capacity_alerts",
                schema: "identity",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    metric = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    percent = table.Column<int>(type: "integer", nullable: false),
                    detected_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    recovered_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_capacity_alerts", x => x.id);
                    table.CheckConstraint("ck_capacity_alerts_metric", "metric IN ('database', 'memory', 'hours')");
                });

            migrationBuilder.CreateTable(
                name: "capacity_samples",
                schema: "identity",
                columns: table => new
                {
                    day = table.Column<DateOnly>(type: "date", nullable: false),
                    database_bytes = table.Column<long>(type: "bigint", nullable: false),
                    working_set_bytes = table.Column<long>(type: "bigint", nullable: true),
                    taken_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_capacity_samples", x => x.day);
                });

            migrationBuilder.CreateIndex(
                name: "ix_capacity_alerts_detected_at",
                schema: "identity",
                table: "capacity_alerts",
                column: "detected_at");

            migrationBuilder.CreateIndex(
                name: "ix_capacity_alerts_metric",
                schema: "identity",
                table: "capacity_alerts",
                column: "metric",
                unique: true,
                filter: "recovered_at IS NULL");

            // Tabelas novas: o papel runtime precisa de DML nelas (a concessão é idempotente e não toca o que já existe).
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("identity"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "capacity_alerts",
                schema: "identity");

            migrationBuilder.DropTable(
                name: "capacity_samples",
                schema: "identity");
        }
    }
}
