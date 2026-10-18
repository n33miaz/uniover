using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;

namespace UniOver.IntegrationTests.TestModule;

/// <summary>Módulo de mentira: prova a base de persistência sem depender de um módulo real.</summary>
public sealed class TestModuleDbContext(DbContextOptions<TestModuleDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "test_module";

    protected override string Schema => SchemaName;

    public DbSet<TestItem> Items => Set<TestItem>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.Entity<TestItem>(e =>
        {
            e.ToTable("items");
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).HasMaxLength(100).IsRequired();
        });
    }
}

public sealed class TestItem
{
    public Guid Id { get; set; }

    public string Name { get; set; } = string.Empty;
}

/// <summary>Usada pelo dotnet ef (migrations e bundle); lê UNIOVER_MIGRATIONS_CONNECTION.</summary>
public sealed class TestModuleDesignTimeFactory : ModuleDesignTimeFactory<TestModuleDbContext>
{
    protected override string Schema => TestModuleDbContext.SchemaName;

    protected override TestModuleDbContext Create(DbContextOptions<TestModuleDbContext> options) => new(options);
}
