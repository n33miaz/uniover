using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Shopping.Domain;

namespace UniOver.Modules.Shopping.Persistence;

/// <summary>Banco isolado de Compras. Contas entram apenas como UUID, sem chave estrangeira para outro schema.</summary>
public sealed class ShoppingDbContext(DbContextOptions<ShoppingDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "shopping";

    protected override string Schema => SchemaName;

    internal DbSet<ShoppingGroup> Groups => Set<ShoppingGroup>();
    internal DbSet<ShoppingMember> Members => Set<ShoppingMember>();
    internal DbSet<Product> Products => Set<Product>();
    internal DbSet<ShoppingListItem> ListItems => Set<ShoppingListItem>();
    internal DbSet<ShoppingPurchase> Purchases => Set<ShoppingPurchase>();
    internal DbSet<PurchaseItem> PurchaseItems => Set<PurchaseItem>();
    internal DbSet<ShoppingOperation> Operations => Set<ShoppingOperation>();
    internal DbSet<ShoppingChange> Changes => Set<ShoppingChange>();
    internal DbSet<ShoppingMemberAuditEntry> MemberAudit => Set<ShoppingMemberAuditEntry>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(ShoppingDbContext).Assembly);
        modelBuilder.AddIdempotency();
    }
}

public sealed class ShoppingDesignTimeFactory : ModuleDesignTimeFactory<ShoppingDbContext>
{
    protected override string Schema => ShoppingDbContext.SchemaName;

    protected override ShoppingDbContext Create(DbContextOptions<ShoppingDbContext> options) => new(options);
}
