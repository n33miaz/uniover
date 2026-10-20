using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddShortcutIcons : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<byte[]>(
                name: "icon_data",
                schema: "tv",
                table: "shortcuts",
                type: "bytea",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "icon_mime",
                schema: "tv",
                table: "shortcuts",
                type: "character varying(20)",
                maxLength: 20,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "icon_sha256",
                schema: "tv",
                table: "shortcuts",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "icon_data",
                schema: "tv",
                table: "shortcuts");

            migrationBuilder.DropColumn(
                name: "icon_mime",
                schema: "tv",
                table: "shortcuts");

            migrationBuilder.DropColumn(
                name: "icon_sha256",
                schema: "tv",
                table: "shortcuts");
        }
    }
}
