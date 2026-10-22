using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    public partial class AddFoods : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "foods",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    source = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    source_ref = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: true),
                    owner_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    name = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    brand = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    barcode = table.Column<string>(type: "character varying(14)", maxLength: 14, nullable: true),
                    kcal_100g = table.Column<decimal>(type: "numeric(7,2)", precision: 7, scale: 2, nullable: false),
                    protein_100g = table.Column<decimal>(type: "numeric(7,2)", precision: 7, scale: 2, nullable: false),
                    carb_100g = table.Column<decimal>(type: "numeric(7,2)", precision: 7, scale: 2, nullable: false),
                    fat_100g = table.Column<decimal>(type: "numeric(7,2)", precision: 7, scale: 2, nullable: false),
                    default_portion_g = table.Column<decimal>(type: "numeric(7,2)", precision: 7, scale: 2, nullable: true),
                    attribution = table.Column<string>(type: "character varying(240)", maxLength: 240, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_foods", x => x.id);
                    table.CheckConstraint("ck_foods_source", "source IN ('own', 'off', 'taco')");
                    table.CheckConstraint("ck_foods_owner_source", "(source = 'own' AND owner_user_id IS NOT NULL) OR (source <> 'own' AND owner_user_id IS NULL)");
                    table.CheckConstraint("ck_foods_source_ref", "(source = 'own' AND source_ref IS NULL) OR (source <> 'own' AND source_ref IS NOT NULL)");
                    table.CheckConstraint("ck_foods_name", "(char_length(btrim(name)) BETWEEN 1 AND 160) OR deleted_at IS NOT NULL");
                    table.CheckConstraint("ck_foods_kcal", "kcal_100g BETWEEN 0 AND 99999.99");
                    table.CheckConstraint("ck_foods_protein", "protein_100g BETWEEN 0 AND 99999.99");
                    table.CheckConstraint("ck_foods_carbs", "carb_100g BETWEEN 0 AND 99999.99");
                    table.CheckConstraint("ck_foods_fat", "fat_100g BETWEEN 0 AND 99999.99");
                    table.CheckConstraint("ck_foods_portion", "default_portion_g IS NULL OR default_portion_g BETWEEN 0.01 AND 10000");
                });

            migrationBuilder.CreateTable(
                name: "meal_entries",
                schema: "training",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    food_id = table.Column<Guid>(type: "uuid", nullable: true),
                    eaten_on = table.Column<DateOnly>(type: "date", nullable: false),
                    eaten_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    meal_type = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: false),
                    name = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    quantity_g = table.Column<decimal>(type: "numeric(7,2)", precision: 7, scale: 2, nullable: false),
                    kcal = table.Column<decimal>(type: "numeric(8,2)", precision: 8, scale: 2, nullable: false),
                    protein_g = table.Column<decimal>(type: "numeric(8,2)", precision: 8, scale: 2, nullable: false),
                    carb_g = table.Column<decimal>(type: "numeric(8,2)", precision: 8, scale: 2, nullable: false),
                    fat_g = table.Column<decimal>(type: "numeric(8,2)", precision: 8, scale: 2, nullable: false),
                    note = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_meal_entries", x => x.id);
                    table.CheckConstraint("ck_meal_entries_type", "meal_type IN ('breakfast', 'lunch', 'snack', 'dinner', 'other')");
                    table.CheckConstraint("ck_meal_entries_grams", "(quantity_g > 0 AND quantity_g <= 10000) OR deleted_at IS NOT NULL");
                    table.CheckConstraint("ck_meal_entries_kcal", "kcal >= 0 AND kcal <= 999999.99");
                    table.CheckConstraint("ck_meal_entries_protein", "protein_g >= 0 AND protein_g <= 999999.99");
                    table.CheckConstraint("ck_meal_entries_carbs", "carb_g >= 0 AND carb_g <= 999999.99");
                    table.CheckConstraint("ck_meal_entries_fat", "fat_g >= 0 AND fat_g <= 999999.99");
                    table.CheckConstraint("ck_meal_entries_note", "note IS NULL OR char_length(note) <= 300");
                    table.ForeignKey(
                        name: "fk_meal_entries_foods_food_id",
                        column: x => x.food_id,
                        principalSchema: "training",
                        principalTable: "foods",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex("ix_foods_source_source_ref", "foods", new[] { "source", "source_ref" }, schema: "training", unique: true, filter: "source_ref IS NOT NULL");
            migrationBuilder.CreateIndex("ix_foods_owner_user_id_updated_at_id", "foods", new[] { "owner_user_id", "updated_at", "id" }, schema: "training");
            migrationBuilder.CreateIndex("ix_foods_barcode", "foods", "barcode", schema: "training", filter: "barcode IS NOT NULL AND deleted_at IS NULL");
            migrationBuilder.CreateIndex("ix_meal_entries_user_id_eaten_on", "meal_entries", new[] { "user_id", "eaten_on" }, schema: "training");
            migrationBuilder.CreateIndex("ix_meal_entries_user_id_updated_at_id", "meal_entries", new[] { "user_id", "updated_at", "id" }, schema: "training");
            migrationBuilder.CreateIndex("ix_meal_entries_food_id", "meal_entries", "food_id", schema: "training");

            migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "meal_entries", schema: "training");
            migrationBuilder.DropTable(name: "foods", schema: "training");
        }
    }
}
