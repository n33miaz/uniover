using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTvLivre : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "tv_livre",
                schema: "tv",
                columns: table => new
                {
                    tv_id = table.Column<Guid>(type: "uuid", nullable: false),
                    config_json = table.Column<string>(type: "jsonb", nullable: true),
                    photo_data = table.Column<byte[]>(type: "bytea", nullable: true),
                    photo_sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    revision = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    state_json = table.Column<string>(type: "jsonb", nullable: true),
                    state_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    state_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_tv_livre", x => x.tv_id);
                });

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("tv"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "tv_livre",
                schema: "tv");
        }
    }
}
