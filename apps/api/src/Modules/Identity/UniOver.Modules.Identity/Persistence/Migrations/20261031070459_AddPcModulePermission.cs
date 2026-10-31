using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace UniOver.Modules.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddPcModulePermission : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_user_grants_permission",
                schema: "identity",
                table: "user_grants");

            migrationBuilder.DropCheckConstraint(
                name: "ck_guest_invites_permissions",
                schema: "identity",
                table: "guest_invites");

            migrationBuilder.AddCheckConstraint(
                name: "ck_user_grants_permission",
                schema: "identity",
                table: "user_grants",
                sql: "permission IN ('module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:edit-shortcuts', 'tv:history', 'module:training', 'module:pc')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_guest_invites_permissions",
                schema: "identity",
                table: "guest_invites",
                sql: "cardinality(permissions) > 0 AND permissions <@ ARRAY['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:edit-shortcuts', 'tv:history', 'module:training', 'module:pc']::text[]");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_user_grants_permission",
                schema: "identity",
                table: "user_grants");

            migrationBuilder.DropCheckConstraint(
                name: "ck_guest_invites_permissions",
                schema: "identity",
                table: "guest_invites");

            migrationBuilder.AddCheckConstraint(
                name: "ck_user_grants_permission",
                schema: "identity",
                table: "user_grants",
                sql: "permission IN ('module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:edit-shortcuts', 'tv:history', 'module:training')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_guest_invites_permissions",
                schema: "identity",
                table: "guest_invites",
                sql: "cardinality(permissions) > 0 AND permissions <@ ARRAY['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:edit-shortcuts', 'tv:history', 'module:training']::text[]");
        }
    }
}
