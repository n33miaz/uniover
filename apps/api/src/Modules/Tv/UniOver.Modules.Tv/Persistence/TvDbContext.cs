using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Tv.Domain;

namespace UniOver.Modules.Tv.Persistence;

/// <summary>Banco do módulo: schema <c>tv</c>, nada em outro schema e nenhuma FK para fora dele.</summary>
public sealed class TvDbContext(DbContextOptions<TvDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "tv";

    protected override string Schema => SchemaName;

    public DbSet<CommandAuditEntry> CommandAudit => Set<CommandAuditEntry>();

    public DbSet<Shortcut> Shortcuts => Set<Shortcut>();

    public DbSet<TvStateRecord> States => Set<TvStateRecord>();

    public DbSet<ConfiguredTv> Tvs => Set<ConfiguredTv>();

    public DbSet<TvMember> TvMembers => Set<TvMember>();

    public DbSet<TvMemberOptOut> TvMemberOptOuts => Set<TvMemberOptOut>();

    public DbSet<TvLayout> TvLayouts => Set<TvLayout>();

    public DbSet<PowerSchedule> PowerSchedules => Set<PowerSchedule>();

    public DbSet<WatchdogEvent> WatchdogEvents => Set<WatchdogEvent>();

    public DbSet<CleanupReportEntry> CleanupReports => Set<CleanupReportEntry>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<CommandAuditEntry>(e =>
        {
            e.ToTable("command_audit");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();

            // Sem FK de propósito: o usuário é de outro módulo (só o id) e a trilha sobrevive a ele.
            e.Property(x => x.AgentId).HasMaxLength(CommandAuditEntry.AgentMax);
            e.Property(x => x.Command).HasMaxLength(CommandAuditEntry.CommandMax).IsRequired();
            e.Property(x => x.Detail).HasMaxLength(CommandAuditEntry.DetailMax);
            e.Property(x => x.ErrorCode).HasMaxLength(CommandAuditEntry.ErrorCodeMax);
            e.Property(x => x.Ip).HasMaxLength(CommandAuditEntry.IpMax);
            e.Property(x => x.UserAgent).HasMaxLength(CommandAuditEntry.UserAgentMax);
            e.HasIndex(x => new { x.TvId, x.OccurredAt });
            e.HasIndex(x => x.OccurredAt);

            // O teto diário conta as linhas do usuário no dia a cada gravação, e o histórico por pessoa filtra por usuário: sem
            // este índice as duas viram varredura da trilha inteira (30 dias de teclas).
            e.HasIndex(x => new { x.UserId, x.OccurredAt });
        });

        modelBuilder.Entity<Shortcut>(e =>
        {
            e.ToTable("shortcuts");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Package).HasMaxLength(Shortcut.PackageMax).IsRequired();
            e.HasIndex(x => new { x.TvId, x.Package }).IsUnique();
            e.Property(x => x.TvLabel).HasMaxLength(Shortcut.TvLabelMax);
            e.Property(x => x.CustomLabel).HasMaxLength(Shortcut.CustomLabelMax);
            e.HasIndex(x => x.Position);
            e.Ignore(x => x.IsActive);

            // Ícone do app: imagem pequena (até 32 KB) tirada do APK pelo agente. Colunas anuláveis e só aditivas.
            e.Property(x => x.IconMime).HasMaxLength(Shortcut.IconMimeMax);
            e.Property(x => x.IconData).HasColumnType("bytea");
            e.Property(x => x.IconSha256).HasMaxLength(Shortcut.IconSha256Length);
        });

        modelBuilder.Entity<TvStateRecord>(e =>
        {
            e.ToTable("tv_state");
            e.HasKey(x => x.AgentId);
            e.Property(x => x.AgentId).HasMaxLength(TvStateRecord.AgentMax).ValueGeneratedNever();
            e.Property(x => x.Power).HasMaxLength(10).IsRequired();
            e.Property(x => x.App).HasMaxLength(TvStateRecord.AppMax);
            e.Property(x => x.Connection).HasMaxLength(20).IsRequired();
        });

        modelBuilder.Entity<ConfiguredTv>(e =>
        {
            e.ToTable("tvs");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Name).HasMaxLength(ConfiguredTv.NameMax).IsRequired();

            // Sem FK de propósito: o agente é do Devices e a conta que salvou é do Identity (só os valores).
            e.Property(x => x.AgentSlug).HasMaxLength(ConfiguredTv.AgentSlugMax).IsRequired();
            e.Property(x => x.AllowBackgroundAppClosing).HasDefaultValue(false);
            e.Property(x => x.FocusModeEnabled).HasDefaultValue(false);
            e.Property(x => x.ShortAnimationsEnabled).HasDefaultValue(false);
            e.Property(x => x.FocusClosesBackground).HasDefaultValue(false);
            e.Property(x => x.AutoMaintenanceEnabled).HasDefaultValue(true);
            e.Property(x => x.PermissionNeeded).HasDefaultValue(false);
            e.Property(x => x.RestrictedBackgroundPackages).HasMaxLength(4000).HasDefaultValue("[]").IsRequired();

            // Exatamente uma TV padrão por enquanto: o índice único parcial impede uma segunda linha padrão mesmo
            // com dois salvamentos ao mesmo tempo. O mesmo agente pode controlar várias TVs no futuro, então o
            // Uma mensagem de um agente precisa ter um único destino; por isso o mesmo computador não controla duas TVs.
            e.HasIndex(x => x.AgentSlug).IsUnique();
            e.HasIndex(x => x.IsDefault).IsUnique().HasFilter("is_default");
        });

        modelBuilder.Entity<TvMember>(e =>
        {
            e.ToTable("tv_members");
            e.HasKey(x => new { x.TvId, x.UserId });
            // O usuário é do Identity, portanto fica somente como UUID, sem FK entre schemas.
            e.HasIndex(x => x.UserId);
        });

        modelBuilder.Entity<TvMemberOptOut>(e =>
        {
            e.ToTable("tv_member_optouts");
            // Uma linha por conta; o usuário é do Identity, portanto só o UUID, sem FK entre schemas.
            e.HasKey(x => x.UserId);
            e.Property(x => x.UserId).ValueGeneratedNever();
        });

        modelBuilder.Entity<TvLayout>(e =>
        {
            e.ToTable("tv_layouts");
            e.HasKey(x => x.TvId);
            e.Property(x => x.TvId).ValueGeneratedNever();
            e.Property(x => x.Document).HasColumnType("jsonb").IsRequired();
        });

        modelBuilder.Entity<PowerSchedule>(e =>
        {
            e.ToTable("power_schedules");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.AgentSlug).HasMaxLength(ConfiguredTv.AgentSlugMax).IsRequired();
            e.Property(x => x.TimeZone).HasMaxLength(100).IsRequired();
            e.Property(x => x.Status).HasMaxLength(20).IsRequired();
            e.Property(x => x.Result).HasMaxLength(30);
            e.Property(x => x.Reason).HasMaxLength(40);
            e.Property(x => x.Version).IsConcurrencyToken();
            // A unicidade continua valendo com duas instâncias da API criando no mesmo instante.
            e.HasIndex(x => x.TvId).IsUnique().HasFilter("status IN ('pending', 'dispatching')");
            e.HasIndex(x => new { x.Status, x.DueAtUtc });
        });

        modelBuilder.Entity<WatchdogEvent>(e =>
        {
            e.ToTable("watchdog_events");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.AgentId).HasMaxLength(WatchdogEvent.AgentMax).IsRequired();
            e.Property(x => x.Kind).HasMaxLength(WatchdogEvent.KindMax).IsRequired();
            e.Property(x => x.Severity).HasMaxLength(WatchdogEvent.SeverityMax).IsRequired();
            e.Property(x => x.Detail).HasMaxLength(WatchdogEvent.DetailMax).IsRequired();
            e.HasIndex(x => x.OccurredAt);
        });

        modelBuilder.Entity<CleanupReportEntry>(e =>
        {
            e.ToTable("cleanup_reports");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Kind).HasMaxLength(CleanupReportEntry.KindMax).IsRequired();
            e.Property(x => x.Trigger).HasMaxLength(CleanupReportEntry.TriggerMax).IsRequired();
            e.Property(x => x.Result).HasMaxLength(CleanupReportEntry.ResultMax).IsRequired();
            e.Property(x => x.Reason).HasMaxLength(CleanupReportEntry.ReasonMax);
            e.Property(x => x.AppsClosed).HasMaxLength(CleanupReportEntry.AppsMax).IsRequired();
            e.Property(x => x.BackgroundProcesses);
            e.Property(x => x.SessionOpenMs);
            e.HasIndex(x => new { x.TvId, x.StartedAt });
        });

        modelBuilder.AddOutbox().AddDeadLetters();
    }
}

/// <summary>Usada só pelo dotnet ef (migrations e bundle); lê <c>UNIOVER_MIGRATIONS_CONNECTION</c>.</summary>
public sealed class TvDesignTimeFactory : ModuleDesignTimeFactory<TvDbContext>
{
    protected override string Schema => TvDbContext.SchemaName;

    protected override TvDbContext Create(DbContextOptions<TvDbContext> options) => new(options);
}
