using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.Modules.Tv.Persistence;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    [DbContext(typeof(TvDbContext))]
    [Migration("20261101170000_RemoveWakeAudit")]
    public partial class RemoveWakeAudit : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Wake só prepara a conexão da sessão; as linhas antigas não representam uma ação na TV e ocupam a trilha.
            migrationBuilder.Sql("DELETE FROM \"tv\".\"command_audit\" WHERE \"command\" = 'tv.wake';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // A limpeza remove registros sem informação de negócio; uma migração não pode recriá-los com fidelidade.
        }
    }
}
