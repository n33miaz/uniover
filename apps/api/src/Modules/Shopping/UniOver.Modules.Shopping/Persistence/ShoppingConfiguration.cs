using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using UniOver.Modules.Shopping.Domain;

namespace UniOver.Modules.Shopping.Persistence;

internal sealed class ShoppingConfiguration :
    IEntityTypeConfiguration<ShoppingGroup>,
    IEntityTypeConfiguration<ShoppingMember>,
    IEntityTypeConfiguration<Product>,
    IEntityTypeConfiguration<ShoppingListItem>,
    IEntityTypeConfiguration<ShoppingPurchase>,
    IEntityTypeConfiguration<PurchaseItem>,
    IEntityTypeConfiguration<ShoppingMergedId>,
    IEntityTypeConfiguration<ShoppingOperation>,
    IEntityTypeConfiguration<ShoppingChange>,
    IEntityTypeConfiguration<ShoppingMemberAuditEntry>
{
    /// <summary>As unicidades valem só para o que está vivo: a lápide não impede recriar o mesmo nome ou o mesmo item.</summary>
    private const string Alive = "deleted_at IS NULL";

    public void Configure(EntityTypeBuilder<ShoppingGroup> builder)
    {
        builder.ToTable("groups");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).ValueGeneratedNever();
    }

    public void Configure(EntityTypeBuilder<ShoppingMember> builder)
    {
        builder.ToTable("members");
        builder.HasKey(x => new { x.GroupId, x.UserId });
        builder.HasOne(x => x.Group).WithMany().HasForeignKey(x => x.GroupId).OnDelete(DeleteBehavior.Restrict);

        // Uma participação ativa por pessoa: é o que faz "o grupo de quem chama" ter uma resposta só.
        builder.HasIndex(x => x.UserId).IsUnique().HasFilter(Alive);
    }

    public void Configure(EntityTypeBuilder<Product> builder)
    {
        builder.ToTable("products", t => t.HasCheckConstraint("ck_products_name", "length(name) > 0"));
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).ValueGeneratedNever();
        builder.Property(x => x.Name).HasMaxLength(ShoppingLimits.Name);
        builder.Property(x => x.NormalizedName).HasMaxLength(ShoppingLimits.Name);
        builder.Property(x => x.Section).HasMaxLength(ShoppingLimits.Section);
        builder.Property(x => x.Unit).HasMaxLength(ShoppingLimits.Unit);
        builder.Property(x => x.Size).HasMaxLength(ShoppingLimits.Size);
        builder.HasOne<ShoppingGroup>().WithMany().HasForeignKey(x => x.GroupId).OnDelete(DeleteBehavior.Restrict);
        builder.HasIndex(x => new { x.GroupId, x.NormalizedName }).IsUnique().HasFilter(Alive);
    }

    public void Configure(EntityTypeBuilder<ShoppingListItem> builder)
    {
        builder.ToTable("list_items", t => t.HasCheckConstraint("ck_list_items_quantity", "quantity > 0"));
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).ValueGeneratedNever();
        builder.Property(x => x.Quantity).HasPrecision(12, 3);
        builder.Property(x => x.Note).HasMaxLength(ShoppingLimits.Note);
        builder.HasOne<ShoppingGroup>().WithMany().HasForeignKey(x => x.GroupId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Product>().WithMany().HasForeignKey(x => x.ProductId).OnDelete(DeleteBehavior.Restrict);
        builder.HasIndex(x => new { x.GroupId, x.ProductId }).IsUnique().HasFilter(Alive);
    }

    public void Configure(EntityTypeBuilder<ShoppingPurchase> builder)
    {
        builder.ToTable("purchases", t =>
        {
            t.HasCheckConstraint("ck_purchases_status", "status IN ('open', 'closed')");
            t.HasCheckConstraint("ck_purchases_money", "(budget IS NULL OR budget >= 0) AND (total_paid IS NULL OR total_paid >= 0)");
        });
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).ValueGeneratedNever();
        builder.Property(x => x.Status).HasMaxLength(10);
        builder.Property(x => x.Budget).HasPrecision(12, 2);
        builder.Property(x => x.TotalPaid).HasPrecision(12, 2);
        builder.Property(x => x.Store).HasMaxLength(ShoppingLimits.Store);
        builder.Property(x => x.ReceiptKey).HasMaxLength(ShoppingLimits.ReceiptKey);
        builder.Property(x => x.ExternalRef).HasMaxLength(ShoppingLimits.ExternalRef);
        builder.HasOne<ShoppingGroup>().WithMany().HasForeignKey(x => x.GroupId).OnDelete(DeleteBehavior.Restrict);
        builder.HasIndex(x => new { x.GroupId, x.Status, x.ClosedAt });

        // Uma compra trazida de fora entra uma vez por grupo, mesmo apagada depois (apagar não pede para trazer de novo).
        // As compras feitas aqui não têm referência e ficam fora do índice.
        builder.HasIndex(x => new { x.GroupId, x.ExternalRef }).IsUnique().HasFilter("external_ref IS NOT NULL");
    }

    public void Configure(EntityTypeBuilder<PurchaseItem> builder)
    {
        builder.ToTable("purchase_items", t =>
        {
            t.HasCheckConstraint("ck_purchase_items_quantity", "quantity > 0");
            t.HasCheckConstraint("ck_purchase_items_unit_price", "unit_price IS NULL OR unit_price >= 0");
        });
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).ValueGeneratedNever();
        builder.Property(x => x.Quantity).HasPrecision(12, 3);
        builder.Property(x => x.UnitPrice).HasPrecision(12, 2);
        builder.HasOne<ShoppingPurchase>().WithMany().HasForeignKey(x => x.PurchaseId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Product>().WithMany().HasForeignKey(x => x.ProductId).OnDelete(DeleteBehavior.Restrict);
        builder.HasIndex(x => new { x.PurchaseId, x.ProductId }).IsUnique().HasFilter(Alive);
    }

    public void Configure(EntityTypeBuilder<ShoppingMergedId> builder)
    {
        builder.ToTable("merged_ids");

        // Dentro do grupo e da espécie: o id de um grupo nunca leva a um registro de outro, nem o de um produto a um item.
        builder.HasKey(x => new { x.GroupId, x.EntityType, x.MergedId });
        builder.Property(x => x.EntityType).HasMaxLength(24);
        builder.HasOne<ShoppingGroup>().WithMany().HasForeignKey(x => x.GroupId).OnDelete(DeleteBehavior.Restrict);
    }

    public void Configure(EntityTypeBuilder<ShoppingOperation> builder)
    {
        builder.ToTable("operations");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).ValueGeneratedNever();
        builder.HasIndex(x => x.GroupId);
    }

    public void Configure(EntityTypeBuilder<ShoppingChange> builder)
    {
        builder.ToTable("changes");
        builder.HasKey(x => x.Sequence);
        builder.Property(x => x.Sequence).UseIdentityAlwaysColumn();
        builder.Property(x => x.EntityType).HasMaxLength(24);
        builder.Property(x => x.Payload).HasColumnType("jsonb");
        builder.HasIndex(x => new { x.GroupId, x.Sequence });
    }

    public void Configure(EntityTypeBuilder<ShoppingMemberAuditEntry> builder)
    {
        builder.ToTable("member_audit");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).ValueGeneratedNever();
        builder.Property(x => x.Event).HasMaxLength(24);
        builder.HasIndex(x => new { x.OccurredAt, x.Id });
    }
}
