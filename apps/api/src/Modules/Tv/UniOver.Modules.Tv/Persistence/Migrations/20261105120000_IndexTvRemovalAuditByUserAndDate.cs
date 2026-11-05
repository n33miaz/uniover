using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.Modules.Tv.Persistence;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    [DbContext(typeof(TvDbContext))]
    [Migration("20261105120000_IndexTvRemovalAuditByUserAndDate")]
    public partial class IndexTvRemovalAuditByUserAndDate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // O histórico de uma pessoa filtra por quem removeu e ordena por data; este índice atende as duas pontas e,
            // com user_id na frente, também faz o trabalho do índice só de usuário, que sai.
            migrationBuilder.CreateIndex(
                name: "ix_tv_removal_audit_user_id_occurred_at",
                schema: "tv",
                table: "tv_removal_audit",
                columns: new[] { "user_id", "occurred_at" });

            migrationBuilder.DropIndex(
                name: "ix_tv_removal_audit_user_id",
                schema: "tv",
                table: "tv_removal_audit");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "ix_tv_removal_audit_user_id",
                schema: "tv",
                table: "tv_removal_audit",
                column: "user_id");

            migrationBuilder.DropIndex(
                name: "ix_tv_removal_audit_user_id_occurred_at",
                schema: "tv",
                table: "tv_removal_audit");
        }
    }
}
