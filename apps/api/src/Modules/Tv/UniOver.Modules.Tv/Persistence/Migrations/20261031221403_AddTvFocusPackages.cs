using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTvFocusPackages : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "focus_packages",
                schema: "tv",
                table: "tvs",
                type: "character varying(4000)",
                maxLength: 4000,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "focus_packages",
                schema: "tv",
                table: "tvs");
        }
    }
}
