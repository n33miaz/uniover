using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.Modules.Training.Persistence;

#nullable disable

namespace UniOver.Modules.Training.Persistence.Migrations
{
    [DbContext(typeof(TrainingDbContext))]
    [Migration("20261022120000_AddIdempotencyGeneration")]
    public sealed class AddIdempotencyGeneration : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "generation",
                schema: "training",
                table: "idempotency_keys",
                type: "uuid",
                nullable: false,
                defaultValueSql: "gen_random_uuid()");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "generation",
                schema: "training",
                table: "idempotency_keys");
        }
    }
}
