using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTvLightSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "focus_mode_enabled",
                schema: "tv",
                table: "tvs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "restricted_background_packages",
                schema: "tv",
                table: "tvs",
                type: "character varying(4000)",
                maxLength: 4000,
                nullable: false,
                defaultValue: "[]");

            migrationBuilder.AddColumn<bool>(
                name: "short_animations_enabled",
                schema: "tv",
                table: "tvs",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "focus_mode_enabled",
                schema: "tv",
                table: "tvs");

            migrationBuilder.DropColumn(
                name: "restricted_background_packages",
                schema: "tv",
                table: "tvs");

            migrationBuilder.DropColumn(
                name: "short_animations_enabled",
                schema: "tv",
                table: "tvs");
        }
    }
}
