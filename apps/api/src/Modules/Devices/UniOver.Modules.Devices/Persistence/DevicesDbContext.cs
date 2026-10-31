using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Devices.Domain;

namespace UniOver.Modules.Devices.Persistence;

/// <summary>Banco do módulo: schema <c>devices</c>, nada em outro schema e nenhuma FK para fora dele.</summary>
public sealed class DevicesDbContext(DbContextOptions<DevicesDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "devices";

    protected override string Schema => SchemaName;

    public DbSet<PairingRequest> Pairings => Set<PairingRequest>();

    public DbSet<Agent> Agents => Set<Agent>();

    public DbSet<AgentPresenceSnapshot> AgentPresenceSnapshots => Set<AgentPresenceSnapshot>();

    public DbSet<PairingAuditEntry> PairingAudit => Set<PairingAuditEntry>();

    public DbSet<AgentOutage> AgentOutages => Set<AgentOutage>();

    public DbSet<AgentDiagnosticEvent> AgentDiagnosticEvents => Set<AgentDiagnosticEvent>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        base.OnModelCreating(modelBuilder);

        // Chaves de idempotência das escritas de aparelhos: devices.idempotency_keys.
        modelBuilder.AddIdempotency();

        modelBuilder.Entity<PairingRequest>(e =>
        {
            e.ToTable("pairings");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.DeviceCodeHash).HasColumnType("bytea").IsRequired();
            e.HasIndex(x => x.DeviceCodeHash).IsUnique();

            // Único entre todos os pedidos guardados; os vencidos há mais de uma hora são apagados na abertura de um novo.
            e.Property(x => x.UserCode).HasMaxLength(UserCode.Length).IsRequired();
            e.HasIndex(x => x.UserCode).IsUnique();
            e.Property(x => x.RequestedName).HasMaxLength(PairingText.NameMax).IsRequired();
            e.Property(x => x.RequestedSlug).HasMaxLength(AgentSlug.MaxLength).IsRequired();
            e.Property(x => x.Platform).HasMaxLength(PairingText.PlatformMax).IsRequired();
            e.Property(x => x.AgentVersion).HasMaxLength(PairingText.VersionMax).IsRequired();
            e.Property(x => x.ApprovedName).HasMaxLength(PairingText.NameMax);
            e.HasIndex(x => x.ExpiresAt);

            // Duas aprovações (ou duas entregas de token) ao mesmo tempo: a segunda grava com o valor antigo
            // e o EF recusa, então só uma vence e o token sai uma única vez.
            e.Property(x => x.ApprovedAt).IsConcurrencyToken();
            e.Property(x => x.ConsumedAt).IsConcurrencyToken();
            e.Property(x => x.DeniedAt).IsConcurrencyToken();

            // Mesmo schema; sem cascata: apagar um agente não apaga o histórico do pedido.
            e.HasOne<Agent>().WithMany().HasForeignKey(x => x.AgentId).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<Agent>(e =>
        {
            e.ToTable("agents");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Slug).HasMaxLength(AgentSlug.MaxLength).IsRequired();
            e.HasIndex(x => x.Slug).IsUnique();
            e.Property(x => x.Name).HasMaxLength(PairingText.NameMax).IsRequired();
            e.Property(x => x.Platform).HasMaxLength(PairingText.PlatformMax).IsRequired();

            // Nulo até a entrega do token; o Postgres aceita vários nulos num índice único.
            e.Property(x => x.TokenHash).HasColumnType("bytea");
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.Property(x => x.RevokeReason).HasMaxLength(Agent.ReasonMax);
            // Revogação e entrega do primeiro token não podem vencer com base na mesma leitura antiga.
            e.Property(x => x.RevokedAt).IsConcurrencyToken();
        });

        modelBuilder.Entity<AgentPresenceSnapshot>(e =>
        {
            e.ToTable("agent_presence_snapshots");
            e.HasKey(x => x.AgentId);
            e.Property(x => x.AgentId).ValueGeneratedNever();
            e.Property(x => x.UpdateOutcome).HasMaxLength(AgentPresenceSnapshot.UpdateOutcomeMax);
            e.Property(x => x.InstalledSha).HasMaxLength(AgentPresenceSnapshot.ShaMax);
            e.Property(x => x.LatestSha).HasMaxLength(AgentPresenceSnapshot.ShaMax);
            e.Property(x => x.BlockedSha).HasMaxLength(AgentPresenceSnapshot.ShaMax);
            e.Property(x => x.PreviousSha).HasMaxLength(AgentPresenceSnapshot.ShaMax);
            e.Property(x => x.UpdateReason).HasMaxLength(AgentPresenceSnapshot.UpdateReasonMax);

            // Só o agente deste módulo pode ter o resumo; revogar não apaga o histórico que a tela ainda mostra.
            e.HasOne<Agent>().WithOne().HasForeignKey<AgentPresenceSnapshot>(x => x.AgentId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<AgentOutage>(e =>
        {
            e.ToTable("agent_outages");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();

            // Uma queda aberta por agente: dois ciclos do monitor (ou duas instâncias) nunca abrem a mesma queda duas vezes.
            e.HasIndex(x => x.AgentId).IsUnique().HasFilter("recovered_at IS NULL").HasDatabaseName("ux_agent_outages_open");
            e.HasIndex(x => x.DetectedAt);
            e.HasOne<Agent>().WithMany().HasForeignKey(x => x.AgentId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<AgentDiagnosticEvent>(e =>
        {
            e.ToTable("agent_diagnostic_events");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Kind).HasMaxLength(AgentDiagnosticEvent.KindMax).IsRequired();
            e.Property(x => x.Severity).HasMaxLength(AgentDiagnosticEvent.SeverityMax).IsRequired();
            e.Property(x => x.Component).HasMaxLength(AgentDiagnosticEvent.ComponentMax);
            e.Property(x => x.Detail).HasMaxLength(AgentDiagnosticEvent.DetailMax).IsRequired();

            // O agente reenvia o mesmo lote depois de uma queda de conexão: o id do evento é único por agente.
            e.HasIndex(x => new { x.AgentId, x.EventId }).IsUnique();
            e.HasIndex(x => new { x.AgentId, x.At });
            e.HasOne<Agent>().WithMany().HasForeignKey(x => x.AgentId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<PairingAuditEntry>(e =>
        {
            e.ToTable("pairing_audit");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Event).HasMaxLength(40).IsRequired();
            e.Property(x => x.Ip).HasMaxLength(AuditText.IpMax);
            e.Property(x => x.UserAgent).HasMaxLength(AuditText.UserAgentMax);
            e.HasIndex(x => x.OccurredAt);

            // Sem FK de propósito: a trilha sobrevive ao agente e ao pedido, e o usuário é de outro módulo.
            e.HasIndex(x => x.AgentId);
        });

        modelBuilder.AddOutbox().AddDeadLetters();
    }
}

/// <summary>Usada só pelo dotnet ef (migrations e bundle); lê <c>UNIOVER_MIGRATIONS_CONNECTION</c>.</summary>
public sealed class DevicesDesignTimeFactory : ModuleDesignTimeFactory<DevicesDbContext>
{
    protected override string Schema => DevicesDbContext.SchemaName;

    protected override DevicesDbContext Create(DbContextOptions<DevicesDbContext> options) => new(options);
}
