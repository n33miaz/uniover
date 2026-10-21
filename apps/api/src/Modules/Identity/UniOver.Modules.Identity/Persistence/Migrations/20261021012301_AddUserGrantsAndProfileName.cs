using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddUserGrantsAndProfileName : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "display_name_confirmed_at",
                schema: "identity",
                table: "users",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string[]>(
                name: "permissions",
                schema: "identity",
                table: "guest_invites",
                type: "text[]",
                nullable: false,
                defaultValueSql: "ARRAY['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:history']::text[]");

            migrationBuilder.CreateTable(
                name: "user_grants",
                schema: "identity",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    permission = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    granted_by = table.Column<Guid>(type: "uuid", nullable: false),
                    granted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_grants", x => new { x.user_id, x.permission });
                    table.CheckConstraint("ck_user_grants_permission", "permission IN ('module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:edit-shortcuts', 'tv:history', 'module:training')");
                    table.ForeignKey(
                        name: "fk_user_grants_users_user_id",
                        column: x => x.user_id,
                        principalSchema: "identity",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.AddCheckConstraint(
                name: "ck_guest_invites_permissions",
                schema: "identity",
                table: "guest_invites",
                sql: "cardinality(permissions) > 0 AND permissions <@ ARRAY['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:edit-shortcuts', 'tv:history', 'module:training']::text[]");

            // Os convidados que já existem ficam com EXATAMENTE o que têm hoje: a TV inteira (teclas, texto, acordar,
            // abrir apps, desligar e o histórico deles), sem editar atalhos (o PATCH de atalhos é só do dono). A lista é
            // escrita à mão de propósito: uma migration aplicada não pode mudar quando uma constante do código mudar, e um
            // teste compara esta lista com o modelo "só controle da TV" do código. Entram também os convidados já
            // revogados (o que eles tinham fica registrado; a revogação, não as permissões, é o que barra o acesso). Quem
            // concedeu é o dono que criou o convite aceito por essa conta; sem convite conhecido, a própria conta. O dono não
            // ganha linhas: ele tem tudo de forma implícita.
            migrationBuilder.Sql(
                """
                INSERT INTO identity.user_grants (user_id, permission, granted_by, granted_at)
                SELECT u.id, p.permission, COALESCE(i.created_by, u.id), u.created_at
                FROM identity.users u
                LEFT JOIN identity.guest_invites i ON i.used_by = u.id
                CROSS JOIN (VALUES ('module:tv'), ('tv:control'), ('tv:power'), ('tv:launch'), ('tv:history')) AS p(permission)
                WHERE u.role = 'guest'
                ON CONFLICT (user_id, permission) DO NOTHING;
                """);

            // Tabela nova: o papel runtime precisa de DML nela (repete a concessão, que é idempotente). As colunas novas
            // herdam os privilégios da tabela. `display_name_confirmed_at` fica nula para todas as contas que já existem
            // (o app pergunta o nome no próximo acesso) e o padrão da coluna `permissions` (o modelo "só controle da TV")
            // serve aos convites já criados e ao código antigo durante a publicação.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("identity"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_grants",
                schema: "identity");

            migrationBuilder.DropCheckConstraint(
                name: "ck_guest_invites_permissions",
                schema: "identity",
                table: "guest_invites");

            migrationBuilder.DropColumn(
                name: "display_name_confirmed_at",
                schema: "identity",
                table: "users");

            migrationBuilder.DropColumn(
                name: "permissions",
                schema: "identity",
                table: "guest_invites");
        }
    }
}
