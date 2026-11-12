using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Shopping.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddPurchaseExternalRef : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "external_ref",
                schema: "shopping",
                table: "purchases",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_purchases_group_id_external_ref",
                schema: "shopping",
                table: "purchases",
                columns: new[] { "group_id", "external_ref" },
                unique: true,
                filter: "external_ref IS NOT NULL");

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("shopping"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_purchases_group_id_external_ref",
                schema: "shopping",
                table: "purchases");

            migrationBuilder.DropColumn(
                name: "external_ref",
                schema: "shopping",
                table: "purchases");
        }
    }
}
