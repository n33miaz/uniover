using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Shopping.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddMergedIds : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "priced_at",
                schema: "shopping",
                table: "purchase_items",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "merged_ids",
                schema: "shopping",
                columns: table => new
                {
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    entity_type = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    merged_id = table.Column<Guid>(type: "uuid", nullable: false),
                    canonical_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_merged_ids", x => new { x.group_id, x.entity_type, x.merged_id });
                    table.ForeignKey(
                        name: "fk_merged_ids_groups_group_id",
                        column: x => x.group_id,
                        principalSchema: "shopping",
                        principalTable: "groups",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            // Tabela nova: o papel da aplicação recebe leitura e escrita nela (as de auditoria seguem só de inclusão).
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("shopping"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "merged_ids",
                schema: "shopping");

            migrationBuilder.DropColumn(
                name: "priced_at",
                schema: "shopping",
                table: "purchase_items");
        }
    }
}
