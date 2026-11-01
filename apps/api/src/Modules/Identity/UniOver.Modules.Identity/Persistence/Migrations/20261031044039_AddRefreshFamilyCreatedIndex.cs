using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddRefreshFamilyCreatedIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "ix_refresh_tokens_family_id_created_at",
                schema: "identity",
                table: "refresh_tokens",
                columns: new[] { "family_id", "created_at" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_refresh_tokens_family_id_created_at",
                schema: "identity",
                table: "refresh_tokens");
        }
    }
}
