using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTvs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "tvs",
                schema: "tv",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    agent_slug = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    is_default = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_by = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_tvs", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_tvs_is_default",
                schema: "tv",
                table: "tvs",
                column: "is_default",
                unique: true,
                filter: "is_default");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "tvs",
                schema: "tv");
        }
    }
}
