using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddGuestPause : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Aditiva: coluna anulável, sem valor padrão; as contas existentes seguem sem pausa.
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "paused_at",
                schema: "identity",
                table: "users",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "paused_at",
                schema: "identity",
                table: "users");
        }
    }
}
