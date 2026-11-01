using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddUniOverCatalogSource : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_exercises_source",
                schema: "training",
                table: "exercises");

            migrationBuilder.AddCheckConstraint(
                name: "ck_exercises_source",
                schema: "training",
                table: "exercises",
                sql: "source IN ('free_exercise_db', 'uniover', 'wger', 'own')");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_exercises_source",
                schema: "training",
                table: "exercises");

            migrationBuilder.AddCheckConstraint(
                name: "ck_exercises_source",
                schema: "training",
                table: "exercises",
                sql: "source IN ('free_exercise_db', 'wger', 'own')");
        }
    }
}
