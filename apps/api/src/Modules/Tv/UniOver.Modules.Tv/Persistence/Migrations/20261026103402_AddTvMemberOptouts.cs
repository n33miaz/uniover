using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTvMemberOptouts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "tv_member_optouts",
                schema: "tv",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_tv_member_optouts", x => x.user_id);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "tv_member_optouts",
                schema: "tv");
        }
    }
}
