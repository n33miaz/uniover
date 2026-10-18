namespace UniOver.BuildingBlocks.Messaging;

/// <summary>Evento publicado, gravado no schema do módulo dono na mesma transação dos dados dele.</summary>
public sealed class OutboxMessage
{
    /// <summary>É o id do evento (UUID v7), o que dá a chave de idempotência do assinante.</summary>
    public Guid Id { get; set; }

    public string Type { get; set; } = string.Empty;

    /// <summary>JSON do evento; o contrato do evento já não carrega credenciais.</summary>
    public string Payload { get; set; } = string.Empty;

    public DateTimeOffset OccurredAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public int Attempts { get; set; }

    public DateTimeOffset NextAttemptAt { get; set; }

    public DateTimeOffset? ProcessedAt { get; set; }

    public string? LastError { get; set; }
}

/// <summary>Evento que esgotou as tentativas: sai da fila e fica guardado para inspeção.</summary>
public sealed class DeadLetter
{
    public Guid Id { get; set; }

    public string Type { get; set; } = string.Empty;

    public string Payload { get; set; } = string.Empty;

    public DateTimeOffset OccurredAt { get; set; }

    public DateTimeOffset FailedAt { get; set; }

    public int Attempts { get; set; }

    public string? LastError { get; set; }
}

/// <summary>Registro de "este consumidor já aplicou este evento"; a chave composta impede repetir o efeito.</summary>
public sealed class InboxMessage
{
    public Guid EventId { get; set; }

    public string Consumer { get; set; } = string.Empty;

    public DateTimeOffset ProcessedAt { get; set; }
}
