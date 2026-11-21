using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Tv.Persistence.Migrations
{
    /// <summary>
    /// Remove do banco a tabela <c>default_tv_followers</c>, que já saiu do modelo em
    /// <see cref="RemoveDefaultTvFollowers"/>. Nenhuma versão da API que possa estar no ar durante o deploy lê ou grava
    /// a tabela, então derrubá-la antes de o código novo entrar não quebra a versão anterior.
    /// </summary>
    public partial class DropDefaultTvFollowers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // SQL direto porque o modelo já não tem a entidade; IF EXISTS deixa a migration idempotente em bancos
            // que nunca tiveram a tabela ou que já a removeram.
            migrationBuilder.Sql("DROP TABLE IF EXISTS tv.default_tv_followers;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Recria a tabela com o mesmo formato de AddDefaultTvFollowers; as linhas antigas não voltam.
            migrationBuilder.CreateTable(
                name: "default_tv_followers",
                schema: "tv",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_default_tv_followers", x => x.user_id);
                });
        }
    }
}
