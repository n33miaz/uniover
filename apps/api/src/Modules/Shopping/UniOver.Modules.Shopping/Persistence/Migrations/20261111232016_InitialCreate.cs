using System;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.BuildingBlocks.Persistence;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace UniOver.Modules.Shopping.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "shopping");

            migrationBuilder.CreateTable(
                name: "changes",
                schema: "shopping",
                columns: table => new
                {
                    sequence = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityAlwaysColumn),
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    operation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    entity_type = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    entity_id = table.Column<Guid>(type: "uuid", nullable: false),
                    payload = table.Column<string>(type: "jsonb", nullable: false),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_changes", x => x.sequence);
                });

            migrationBuilder.CreateTable(
                name: "groups",
                schema: "shopping",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    owner_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_groups", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "idempotency_keys",
                schema: "shopping",
                columns: table => new
                {
                    key = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    route = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    request_hash = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: false),
                    generation = table.Column<Guid>(type: "uuid", nullable: false, defaultValueSql: "gen_random_uuid()"),
                    status_code = table.Column<int>(type: "integer", nullable: true),
                    response_body = table.Column<string>(type: "text", nullable: true),
                    content_type = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    location = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_idempotency_keys", x => new { x.user_id, x.key });
                });

            migrationBuilder.CreateTable(
                name: "operations",
                schema: "shopping",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    actor_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    applied_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_operations", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "members",
                schema: "shopping",
                columns: table => new
                {
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    is_owner = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_members", x => new { x.group_id, x.user_id });
                    table.ForeignKey(
                        name: "fk_members_groups_group_id",
                        column: x => x.group_id,
                        principalSchema: "shopping",
                        principalTable: "groups",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "products",
                schema: "shopping",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    normalized_name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    section = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    unit = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: true),
                    size = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_products", x => x.id);
                    table.CheckConstraint("ck_products_name", "length(name) > 0");
                    table.ForeignKey(
                        name: "fk_products_groups_group_id",
                        column: x => x.group_id,
                        principalSchema: "shopping",
                        principalTable: "groups",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "purchases",
                schema: "shopping",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    budget = table.Column<decimal>(type: "numeric(12,2)", precision: 12, scale: 2, nullable: true),
                    total_paid = table.Column<decimal>(type: "numeric(12,2)", precision: 12, scale: 2, nullable: true),
                    store = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    receipt_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    closed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_purchases", x => x.id);
                    table.CheckConstraint("ck_purchases_money", "(budget IS NULL OR budget >= 0) AND (total_paid IS NULL OR total_paid >= 0)");
                    table.CheckConstraint("ck_purchases_status", "status IN ('open', 'closed')");
                    table.ForeignKey(
                        name: "fk_purchases_groups_group_id",
                        column: x => x.group_id,
                        principalSchema: "shopping",
                        principalTable: "groups",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "list_items",
                schema: "shopping",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    product_id = table.Column<Guid>(type: "uuid", nullable: false),
                    quantity = table.Column<decimal>(type: "numeric(12,3)", precision: 12, scale: 3, nullable: false),
                    note = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    needed = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_list_items", x => x.id);
                    table.CheckConstraint("ck_list_items_quantity", "quantity > 0");
                    table.ForeignKey(
                        name: "fk_list_items_groups_group_id",
                        column: x => x.group_id,
                        principalSchema: "shopping",
                        principalTable: "groups",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_list_items_products_product_id",
                        column: x => x.product_id,
                        principalSchema: "shopping",
                        principalTable: "products",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "purchase_items",
                schema: "shopping",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    purchase_id = table.Column<Guid>(type: "uuid", nullable: false),
                    product_id = table.Column<Guid>(type: "uuid", nullable: false),
                    quantity = table.Column<decimal>(type: "numeric(12,3)", precision: 12, scale: 3, nullable: false),
                    unit_price = table.Column<decimal>(type: "numeric(12,2)", precision: 12, scale: 2, nullable: true),
                    picked = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_purchase_items", x => x.id);
                    table.CheckConstraint("ck_purchase_items_quantity", "quantity > 0");
                    table.CheckConstraint("ck_purchase_items_unit_price", "unit_price IS NULL OR unit_price >= 0");
                    table.ForeignKey(
                        name: "fk_purchase_items_products_product_id",
                        column: x => x.product_id,
                        principalSchema: "shopping",
                        principalTable: "products",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_purchase_items_purchases_purchase_id",
                        column: x => x.purchase_id,
                        principalSchema: "shopping",
                        principalTable: "purchases",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_changes_group_id_sequence",
                schema: "shopping",
                table: "changes",
                columns: new[] { "group_id", "sequence" });

            migrationBuilder.CreateIndex(
                name: "ix_idempotency_keys_expires_at",
                schema: "shopping",
                table: "idempotency_keys",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_list_items_group_id_product_id",
                schema: "shopping",
                table: "list_items",
                columns: new[] { "group_id", "product_id" },
                unique: true,
                filter: "deleted_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_list_items_product_id",
                schema: "shopping",
                table: "list_items",
                column: "product_id");

            migrationBuilder.CreateIndex(
                name: "ix_members_user_id",
                schema: "shopping",
                table: "members",
                column: "user_id",
                unique: true,
                filter: "deleted_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_operations_group_id",
                schema: "shopping",
                table: "operations",
                column: "group_id");

            migrationBuilder.CreateIndex(
                name: "ix_products_group_id_normalized_name",
                schema: "shopping",
                table: "products",
                columns: new[] { "group_id", "normalized_name" },
                unique: true,
                filter: "deleted_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_purchase_items_product_id",
                schema: "shopping",
                table: "purchase_items",
                column: "product_id");

            migrationBuilder.CreateIndex(
                name: "ix_purchase_items_purchase_id_product_id",
                schema: "shopping",
                table: "purchase_items",
                columns: new[] { "purchase_id", "product_id" },
                unique: true,
                filter: "deleted_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_purchases_group_id_status_closed_at",
                schema: "shopping",
                table: "purchases",
                columns: new[] { "group_id", "status", "closed_at" });

            // Permissões do papel runtime (só DML); o papel é lido da variável de ambiente ao aplicar.
            migrationBuilder.Sql(RuntimeRoleGrants.Sql("shopping"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "changes",
                schema: "shopping");

            migrationBuilder.DropTable(
                name: "idempotency_keys",
                schema: "shopping");

            migrationBuilder.DropTable(
                name: "list_items",
                schema: "shopping");

            migrationBuilder.DropTable(
                name: "members",
                schema: "shopping");

            migrationBuilder.DropTable(
                name: "operations",
                schema: "shopping");

            migrationBuilder.DropTable(
                name: "purchase_items",
                schema: "shopping");

            migrationBuilder.DropTable(
                name: "products",
                schema: "shopping");

            migrationBuilder.DropTable(
                name: "purchases",
                schema: "shopping");

            migrationBuilder.DropTable(
                name: "groups",
                schema: "shopping");
        }
    }
}
