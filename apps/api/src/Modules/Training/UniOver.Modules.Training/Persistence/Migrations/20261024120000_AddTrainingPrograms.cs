using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Training.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations;

[DbContext(typeof(TrainingDbContext))]
[Migration("20261024120000_AddTrainingPrograms")]
public sealed class AddTrainingPrograms : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(name: "program_id", table: "routines", schema: "training", type: "character varying(80)", maxLength: 80, nullable: true);
        migrationBuilder.AddColumn<int[]>(name: "weekdays", table: "routines", schema: "training", type: "integer[]", nullable: false, defaultValue: Array.Empty<int>());
        migrationBuilder.CreateTable(
            name: "programs", schema: "training",
            columns: table => new
            {
                user_id = table.Column<Guid>(type: "uuid", nullable: false),
                program_id = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                client_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
            },
            constraints: table => table.PrimaryKey("pk_programs", x => x.user_id));
        migrationBuilder.Sql(RuntimeRoleGrants.Sql("training"));
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable("programs", "training");
        migrationBuilder.DropColumn("program_id", "routines", "training");
        migrationBuilder.DropColumn("weekdays", "routines", "training");
    }
}
