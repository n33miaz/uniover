using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Persistence;

/// <summary>Banco do módulo: schema <c>identity</c>, nada em outro schema e nenhuma FK para fora dele.</summary>
public sealed class IdentityDbContext(DbContextOptions<IdentityDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "identity";

    protected override string Schema => SchemaName;

    public DbSet<User> Users => Set<User>();

    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

    public DbSet<RefreshDeviceKey> RefreshDeviceKeys => Set<RefreshDeviceKey>();

    public DbSet<RefreshRecoveryChallenge> RefreshRecoveryChallenges => Set<RefreshRecoveryChallenge>();

    public DbSet<LoginAuditEntry> LoginAudit => Set<LoginAuditEntry>();

    public DbSet<Passkey> Passkeys => Set<Passkey>();

    public DbSet<WebAuthnChallenge> WebAuthnChallenges => Set<WebAuthnChallenge>();

    public DbSet<StepUpConfirmation> StepUpConfirmations => Set<StepUpConfirmation>();

    public DbSet<GuestInvite> GuestInvites => Set<GuestInvite>();

    public DbSet<UserGrant> UserGrants => Set<UserGrant>();
    public DbSet<SystemSetting> SystemSettings => Set<SystemSetting>();

    public DbSet<QrLoginRequest> QrLoginRequests => Set<QrLoginRequest>();

    /// <summary>
    /// A lista do catálogo como texto SQL (<c>'module:tv', 'tv:control', ...</c>) para as restrições do banco. Só
    /// constantes do código entram aqui (nenhum dado de usuário). Quando o catálogo muda, o modelo muda e o EF exige uma
    /// migration nova: é assim que "permissão nova entra por migration".
    /// </summary>
    private static string CatalogSqlList() => string.Join(", ", AccessPermissions.All.Select(p => $"'{p}'"));

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        base.OnModelCreating(modelBuilder);

        // Chaves de idempotência das escritas da conta: identity.idempotency_keys.
        modelBuilder.AddIdempotency();

        modelBuilder.Entity<User>(e =>
        {
            e.ToTable("users", t => t.HasCheckConstraint("ck_users_role", "role IN ('owner', 'guest')"));
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Email).HasMaxLength(EmailRules.MaximumLength).IsRequired();
            e.HasIndex(x => x.Email).IsUnique();
            e.Property(x => x.DisplayName).HasMaxLength(100).IsRequired();
            e.Property(x => x.PasswordHash).HasMaxLength(500).IsRequired();

            // Nula para toda conta que já existia: o app pergunta o nome no próximo acesso.
            e.Property(x => x.DisplayNameConfirmedAt);

            // A linha que já existia antes dos convidados é a do dono: o padrão do banco é `owner`.
            e.Property(x => x.Role).HasMaxLength(20).IsRequired().HasDefaultValue(AccountRoles.Owner);
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

        modelBuilder.Entity<RefreshDeviceKey>(e =>
        {
            e.ToTable("refresh_device_keys");
            e.HasKey(x => x.FamilyId);
            e.Property(x => x.FamilyId).ValueGeneratedNever();
            e.Property(x => x.PublicKey).HasMaxLength(Security.DeviceProof.KeyMaxLength).IsRequired();
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<RefreshRecoveryChallenge>(e =>
        {
            e.ToTable("refresh_recovery_challenges");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.NonceHash).HasColumnType("bytea").IsRequired();
            e.HasIndex(x => x.FamilyId);
            e.HasIndex(x => x.ExpiresAt);

            // O desafio some junto com o token a que pertence (limpeza de sessões antigas, conta apagada).
            e.HasOne<RefreshToken>().WithMany().HasForeignKey(x => x.TokenId).OnDelete(DeleteBehavior.Cascade);
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

        modelBuilder.Entity<Passkey>(e =>
        {
            e.ToTable("passkeys");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.CredentialId).HasColumnType("bytea").IsRequired();
            e.HasIndex(x => x.CredentialId).IsUnique();
            e.Property(x => x.PublicKey).HasColumnType("bytea").IsRequired();
            e.Property(x => x.Name).HasMaxLength(PasskeyRules.MaxNameLength).IsRequired();
            e.Property(x => x.Transports).HasMaxLength(100);
            e.HasIndex(x => x.UserId);

            // Apagar a conta (recuperação manual) leva as passkeys junto, dentro do mesmo schema.
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<WebAuthnChallenge>(e =>
        {
            e.ToTable("webauthn_challenges");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Purpose).HasMaxLength(20).IsRequired();
            e.Property(x => x.Action).HasMaxLength(64);
            e.Property(x => x.OptionsJson).HasColumnType("text").IsRequired();
            e.HasIndex(x => x.ExpiresAt);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<StepUpConfirmation>(e =>
        {
            e.ToTable("step_up_confirmations");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Action).HasMaxLength(64).IsRequired();

            // A consulta do requisito filtra por sessão e ação; a limpeza oportunista, por vencimento.
            e.HasIndex(x => new { x.SessionFamilyId, x.Action });
            e.HasIndex(x => x.ExpiresAt);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<GuestInvite>(e =>
        {
            e.ToTable("guest_invites", t => t.HasCheckConstraint(
                "ck_guest_invites_permissions",
                $"cardinality(permissions) > 0 AND permissions <@ ARRAY[{CatalogSqlList()}]::text[]"));
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.TokenHash).HasColumnType("bytea").IsRequired();
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.Property(x => x.Role).HasMaxLength(20).IsRequired();

            // Largura da coluna maior que o limite do nome (60): convites antigos já gravados não ficam fora do esquema.
            e.Property(x => x.Label).HasMaxLength(100).IsRequired();

            // O padrão da coluna (o modelo "só controle da TV") só existe no banco, na migration: serve aos convites que já
            // existiam e ao código antigo durante a publicação. O código novo sempre grava a lista de forma explícita.
            e.Property(x => x.Permissions).HasColumnType("text[]").IsRequired();
            e.HasIndex(x => x.CreatedBy);

            // Sem FK de propósito: quem criou e quem aceitou são contas, e a trilha do convite sobrevive à exclusão manual delas.
        });

        modelBuilder.Entity<QrLoginRequest>(e =>
        {
            e.ToTable("qr_login_requests");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).ValueGeneratedNever();

            // Só hashes: o código do QR e o segredo de consulta nunca ficam legíveis no banco.
            e.Property(x => x.CodeHash).HasColumnType("bytea").IsRequired();
            e.HasIndex(x => x.CodeHash).IsUnique();
            e.Property(x => x.PollSecretHash).HasColumnType("bytea").IsRequired();
            e.HasIndex(x => x.PollSecretHash).IsUnique();
            e.Property(x => x.RequesterIp).HasMaxLength(AuditText.IpMax);
            e.Property(x => x.RequesterUserAgent).HasMaxLength(AuditText.UserAgentMax);
            e.Property(x => x.ApproverIp).HasMaxLength(AuditText.IpMax);
            e.Property(x => x.ApproverUserAgent).HasMaxLength(AuditText.UserAgentMax);

            // A limpeza oportunista e o teto de pedidos abertos filtram por vencimento.
            e.HasIndex(x => x.ExpiresAt);

            // Sem FK de propósito: `approved_by` é só o id de quem confirmou, e a trilha sobrevive à exclusão manual da conta.
        });

        modelBuilder.Entity<UserGrant>(e =>
        {
            e.ToTable("user_grants", t => t.HasCheckConstraint("ck_user_grants_permission", $"permission IN ({CatalogSqlList()})"));
            e.HasKey(x => new { x.UserId, x.Permission });
            e.Property(x => x.Permission).HasMaxLength(64).IsRequired();

            // `granted_by` é só o id de quem concedeu: sem FK (a trilha sobrevive à exclusão manual da conta do dono).
            // Apagar a conta (recuperação manual) leva as concessões junto, dentro do mesmo schema.
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<SystemSetting>(e =>
        {
            e.ToTable("system_settings");
            e.HasKey(x => x.Key);
            e.Property(x => x.Key).HasMaxLength(64).IsRequired();
            e.Property(x => x.ValueJson).HasColumnType("jsonb").IsRequired();
        });
    }
}

/// <summary>Usada só pelo dotnet ef (migrations e bundle); lê <c>UNIOVER_MIGRATIONS_CONNECTION</c>.</summary>
public sealed class IdentityDesignTimeFactory : ModuleDesignTimeFactory<IdentityDbContext>
{
    protected override string Schema => IdentityDbContext.SchemaName;

    protected override IdentityDbContext Create(DbContextOptions<IdentityDbContext> options) => new(options);
}
