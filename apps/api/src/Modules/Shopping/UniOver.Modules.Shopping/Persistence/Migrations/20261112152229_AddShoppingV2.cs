using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Shopping.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddShoppingV2 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "from_list",
                schema: "shopping",
                table: "purchases",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddColumn<string>(
                name: "promo_note",
                schema: "shopping",
                table: "purchase_items",
                type: "character varying(40)",
                maxLength: 40,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "regular_price",
                schema: "shopping",
                table: "purchase_items",
                type: "numeric(12,2)",
                precision: 12,
                scale: 2,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "group_invites",
                schema: "shopping",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    token_hash = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    used_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    used_by = table.Column<Guid>(type: "uuid", nullable: true),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_group_invites", x => x.id);
                    table.ForeignKey(
                        name: "fk_group_invites_groups_group_id",
                        column: x => x.group_id,
                        principalSchema: "shopping",
                        principalTable: "groups",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.AddCheckConstraint(
                name: "ck_purchase_items_regular_price",
                schema: "shopping",
                table: "purchase_items",
                sql: "regular_price IS NULL OR regular_price >= 0");

            migrationBuilder.CreateIndex(
                name: "ix_group_invites_group_id",
                schema: "shopping",
                table: "group_invites",
                column: "group_id");

            migrationBuilder.CreateIndex(
                name: "ix_group_invites_token_hash",
                schema: "shopping",
                table: "group_invites",
                column: "token_hash",
                unique: true);

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("shopping"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "group_invites",
                schema: "shopping");

            migrationBuilder.DropCheckConstraint(
                name: "ck_purchase_items_regular_price",
                schema: "shopping",
                table: "purchase_items");

            migrationBuilder.DropColumn(
                name: "from_list",
                schema: "shopping",
                table: "purchases");

            migrationBuilder.DropColumn(
                name: "promo_note",
                schema: "shopping",
                table: "purchase_items");

            migrationBuilder.DropColumn(
                name: "regular_price",
                schema: "shopping",
                table: "purchase_items");
        }
    }
}
