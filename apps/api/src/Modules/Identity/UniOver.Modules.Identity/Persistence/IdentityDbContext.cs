using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Persistence;

/// <summary>Banco do módulo: schema <c>identity</c>, nada em outro schema e nenhuma FK para fora dele.</summary>
public sealed class IdentityDbContext(DbContextOptions<IdentityDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "identity";

    protected override string Schema => SchemaName;

    public DbSet<User> Users => Set<User>();

    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

    public DbSet<LoginAuditEntry> LoginAudit => Set<LoginAuditEntry>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<User>(e =>
        {
            e.ToTable("users");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Email).HasMaxLength(EmailRules.MaximumLength).IsRequired();
            e.HasIndex(x => x.Email).IsUnique();
            e.Property(x => x.DisplayName).HasMaxLength(100).IsRequired();
            e.Property(x => x.PasswordHash).HasMaxLength(500).IsRequired();
        });

        modelBuilder.Entity<RefreshToken>(e =>
        {
            e.ToTable("refresh_tokens");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.TokenHash).HasColumnType("bytea").IsRequired();
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.FamilyId);
            e.Property(x => x.RevokedReason).HasMaxLength(40);
            e.Property(x => x.Ip).HasMaxLength(AuditText.IpMax);
            e.Property(x => x.UserAgent).HasMaxLength(AuditText.UserAgentMax);

            // Apagar a conta (caminho manual de recuperação) leva as sessões junto, dentro do mesmo schema.
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<LoginAuditEntry>(e =>
        {
            e.ToTable("login_audit");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Event).HasMaxLength(40).IsRequired();
            e.Property(x => x.Ip).HasMaxLength(AuditText.IpMax);
            e.Property(x => x.UserAgent).HasMaxLength(AuditText.UserAgentMax);
            e.Property(x => x.Detail).HasMaxLength(AuditText.DetailMax);
            e.HasIndex(x => x.OccurredAt);

            // Sem FK de propósito: a trilha precisa sobreviver à exclusão da conta e aceita user_id nulo.
            e.HasIndex(x => x.UserId);
        });
    }
}

/// <summary>Usada só pelo dotnet ef (migrations e bundle); lê <c>UNIOVER_MIGRATIONS_CONNECTION</c>.</summary>
public sealed class IdentityDesignTimeFactory : ModuleDesignTimeFactory<IdentityDbContext>
{
    protected override string Schema => IdentityDbContext.SchemaName;

    protected override IdentityDbContext Create(DbContextOptions<IdentityDbContext> options) => new(options);
}
