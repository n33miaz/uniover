using Microsoft.EntityFrameworkCore;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>
/// Mapeamento das tabelas de mensageria. Cada módulo chama no <c>OnModelCreating</c>, depois da base (que
/// define o schema padrão): as tabelas moram sempre no schema do módulo, nunca numa tabela central.
/// Nomes de tabela e de coluna são explícitos para não depender da convenção de nomes do contexto, porque o
/// despachante lê a outbox com SQL próprio.
/// </summary>
public static class MessagingModelBuilderExtensions
{
    public const string OutboxTable = "outbox_messages";
    public const string DeadLetterTable = "dead_letters";
    public const string InboxTable = "inbox_messages";

    /// <summary>Nome da chave do inbox: distingue a violação do inbox de outra violação de unicidade do efeito.</summary>
    internal const string InboxKeyName = "pk_inbox_messages";

    public static ModelBuilder AddOutbox(this ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);

        modelBuilder.Entity<OutboxMessage>(e =>
        {
            e.ToTable(OutboxTable);
            e.HasKey(x => x.Id).HasName("pk_outbox_messages");
            e.Property(x => x.Id).HasColumnName("id").ValueGeneratedNever();
            e.Property(x => x.Type).HasColumnName("type").HasMaxLength(200).IsRequired();
            e.Property(x => x.Payload).HasColumnName("payload").HasColumnType("jsonb").IsRequired();
            e.Property(x => x.OccurredAt).HasColumnName("occurred_at");
            e.Property(x => x.CreatedAt).HasColumnName("created_at");
            e.Property(x => x.Attempts).HasColumnName("attempts");
            e.Property(x => x.NextAttemptAt).HasColumnName("next_attempt_at");
            e.Property(x => x.ProcessedAt).HasColumnName("processed_at");
            e.Property(x => x.LastError).HasColumnName("last_error").HasMaxLength(300);

            // Parcial: só o que ainda está pendente interessa à varredura; a fila vazia custa quase nada.
            e.HasIndex(x => x.NextAttemptAt).HasDatabaseName("ix_outbox_messages_pending").HasFilter("processed_at IS NULL");
        });

        return modelBuilder;
    }

    public static ModelBuilder AddDeadLetters(this ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);

        modelBuilder.Entity<DeadLetter>(e =>
        {
            e.ToTable(DeadLetterTable);
            e.HasKey(x => x.Id).HasName("pk_dead_letters");
            e.Property(x => x.Id).HasColumnName("id").ValueGeneratedNever();
            e.Property(x => x.Type).HasColumnName("type").HasMaxLength(200).IsRequired();
            e.Property(x => x.Payload).HasColumnName("payload").HasColumnType("jsonb").IsRequired();
            e.Property(x => x.OccurredAt).HasColumnName("occurred_at");
            e.Property(x => x.FailedAt).HasColumnName("failed_at");
            e.Property(x => x.Attempts).HasColumnName("attempts");
            e.Property(x => x.LastError).HasColumnName("last_error").HasMaxLength(300);
        });

        return modelBuilder;
    }

    public static ModelBuilder AddInbox(this ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);

        modelBuilder.Entity<InboxMessage>(e =>
        {
            e.ToTable(InboxTable);
            e.HasKey(x => new { x.EventId, x.Consumer }).HasName(InboxKeyName);
            e.Property(x => x.EventId).HasColumnName("event_id").ValueGeneratedNever();
            e.Property(x => x.Consumer).HasColumnName("consumer").HasMaxLength(200);
            e.Property(x => x.ProcessedAt).HasColumnName("processed_at");
        });

        return modelBuilder;
    }
}
