using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <summary>
    /// Tira <c>default_tv_followers</c> do modelo sem tocar no banco. A tabela fica: as migrations rodam antes do código
    /// novo entrar no ar, e a versão anterior da API ainda a lê em toda seleção de TV de convidado. O código desta versão
    /// não a usa mais (a TV padrão segue só a concessão vigente no Identity), então as linhas que sobrarem não valem nada.
    /// A remoção física vem numa migration de uma versão seguinte, depois que nenhuma versão no ar a ler.
    /// </summary>
    public partial class RemoveDefaultTvFollowers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
        }
    }
}
