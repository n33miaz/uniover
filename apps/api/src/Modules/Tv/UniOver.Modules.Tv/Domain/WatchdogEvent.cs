using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Domain;

/// <summary>Um evento do vigia da TV (linha do tempo de reparos), do jeito que o agente o reportou.</summary>
public sealed class WatchdogEvent
{
    public const int AgentMax = 40;
    public const int KindMax = 30;
    public const int SeverityMax = 10;
    public const int DetailMax = 200;

    // Para o EF Core materializar a linha.
    private WatchdogEvent()
    {
    }

    public Guid Id { get; private set; }

    public string AgentId { get; private set; } = string.Empty;

    public string Kind { get; private set; } = string.Empty;

    public string Severity { get; private set; } = string.Empty;

    public string Detail { get; private set; } = string.Empty;

    public int Attempts { get; private set; }

    /// <summary>Quando o agente observou o evento.</summary>
    public DateTimeOffset OccurredAt { get; private set; }

    /// <summary>Quando a API recebeu a mensagem.</summary>
    public DateTimeOffset ReceivedAt { get; private set; }

    public static WatchdogEvent Create(
        string agentId, string kind, string severity, string detail, int attempts, DateTimeOffset occurredAt, DateTimeOffset receivedAt) =>
        new()
        {
            Id = IdGenerator.NewId(),
            AgentId = agentId,
            Kind = kind,
            Severity = severity,
            Detail = detail,
            Attempts = attempts,
            OccurredAt = occurredAt,
            ReceivedAt = receivedAt,
        };
}
