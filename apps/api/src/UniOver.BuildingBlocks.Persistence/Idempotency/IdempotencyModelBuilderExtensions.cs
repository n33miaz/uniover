using Microsoft.EntityFrameworkCore;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// Mapeamento da tabela de chaves de idempotência. Cada módulo que aceita escrita com reenvio chama no
/// <c>OnModelCreating</c>, depois da base (que define o schema padrão): a tabela mora sempre no schema do
/// módulo, nunca numa tabela central.
/// </summary>
public static class IdempotencyModelBuilderExtensions
{
    public const string Table = "idempotency_keys";

    public static ModelBuilder AddIdempotency(this ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);

        modelBuilder.Entity<IdempotencyRecord>(e =>
        {
            e.ToTable(Table);
            e.HasKey(x => new { x.UserId, x.Key }).HasName("pk_idempotency_keys");
            e.Property(x => x.UserId).HasColumnName("user_id");
            e.Property(x => x.Key).HasColumnName("key");
            e.Property(x => x.Method).HasColumnName("method").HasMaxLength(10).IsRequired();
            e.Property(x => x.Route).HasColumnName("route").HasMaxLength(300).IsRequired();
            e.Property(x => x.RequestHash).HasColumnName("request_hash").HasMaxLength(32).IsRequired();
            e.Property(x => x.Generation).HasColumnName("generation").HasDefaultValueSql("gen_random_uuid()").IsRequired();
            e.Property(x => x.StatusCode).HasColumnName("status_code");
            e.Property(x => x.ResponseBody).HasColumnName("response_body");
            e.Property(x => x.ContentType).HasColumnName("content_type").HasMaxLength(200);
            e.Property(x => x.Location).HasColumnName("location").HasMaxLength(2000);
            e.Property(x => x.CreatedAt).HasColumnName("created_at");
            e.Property(x => x.CompletedAt).HasColumnName("completed_at");
            e.Property(x => x.ExpiresAt).HasColumnName("expires_at");

            // A limpeza oportunista apaga por vencimento; sem o índice cada inserção varreria a tabela inteira.
            e.HasIndex(x => x.ExpiresAt).HasDatabaseName("ix_idempotency_keys_expires_at");
        });

        return modelBuilder;
    }
}

/// <summary>Limites e prazos da idempotência de escrita.</summary>
public static class IdempotencyLimits
{
    /// <summary>Acima disto a resposta guarda só o status e o <c>Location</c>, sem corpo.</summary>
    public const int MaxStoredBodyBytes = 32 * 1024;

    /// <summary>Quanto uma chave vive (o cliente pode reenviar por até uma semana sem rede).</summary>
    public static readonly TimeSpan Retention = TimeSpan.FromDays(7);

    /// <summary>Um "em andamento" parado há mais que isto é de um processo que caiu: conta como inexistente.</summary>
    public static readonly TimeSpan InProgressTimeout = TimeSpan.FromSeconds(60);
}
