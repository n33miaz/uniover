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
            // A fonte pode já estar em rotinas, séries e escolhas de carga. Um rollback não pode apagar esses dados
            // silenciosamente nem deixar o banco com referências quebradas.
            migrationBuilder.Sql("""
                DO $$
                BEGIN
                    RAISE EXCEPTION 'A migration AddUniOverCatalogSource é irreversível porque a remoção da fonte uniover pode quebrar referências de usuários.';
                END $$;
                """);
        }
    }
}
