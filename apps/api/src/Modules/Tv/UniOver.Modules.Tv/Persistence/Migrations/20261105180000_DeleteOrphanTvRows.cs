using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.Modules.Tv.Persistence;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    [DbContext(typeof(TvDbContext))]
    [Migration("20261105180000_DeleteOrphanTvRows")]
    public partial class DeleteOrphanTvRows : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Uma mensagem do agente ou uma requisição que já tinha resolvido a TV podia gravar DEPOIS da remoção e deixar
            // estas linhas sem dono. As tabelas não têm FK para tvs de propósito (tv_id = 00000000-0000-0000-0000-000000000000
            // é a instalação antiga, sem linha de TV, e continua valendo), então só se apaga o que aponta para uma TV que não
            // existe mais. Dados, sem mudança de esquema: o snapshot não muda.
            foreach (var table in new[] { "shortcuts", "tv_layouts", "power_schedules", "siri_tokens", "tv_livre", "cleanup_reports" })
            {
                migrationBuilder.Sql(
                    $"DELETE FROM tv.{table} t WHERE t.tv_id <> '00000000-0000-0000-0000-000000000000' " +
                    "AND NOT EXISTS (SELECT 1 FROM tv.tvs v WHERE v.id = t.tv_id);");
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Linhas sem dono não voltam: nada a desfazer.
        }
    }
}
