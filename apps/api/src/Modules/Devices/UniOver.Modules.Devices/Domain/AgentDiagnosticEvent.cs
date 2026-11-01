namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// Uma ocorrência que o próprio agente contou (queda, tarefa de fundo que falhou, reparo, atualização recusada) para o
/// administrador ver em Sistema. O texto já chega do agente sem caminhos, endereços e segredos; aqui só se limita o tamanho.
/// Não é trilha de auditoria: some em poucos dias e em quantidade limitada por agente.
/// </summary>
public sealed class AgentDiagnosticEvent
{
    public const int KindMax = 48;
    public const int ComponentMax = 32;
    public const int DetailMax = 300;
    public const int SeverityMax = 8;

    /// <summary>Marca que a API descartou eventos por excesso (no máximo uma por hora e por agente).</summary>
    public const string DroppedKind = "diagnostics.dropped";

    // Para o EF Core materializar a linha.
    private AgentDiagnosticEvent()
    {
    }

    public Guid Id { get; private set; }

    public Guid AgentId { get; private set; }

    /// <summary>O <c>id</c> do evento escolhido pelo agente: reenviar o mesmo lote não duplica nada.</summary>
    public Guid EventId { get; private set; }

    /// <summary>Quando aconteceu, pelo relógio do agente (ou a hora do recebimento, se ele estava fora do razoável).</summary>
    public DateTimeOffset At { get; private set; }

    public DateTimeOffset ReceivedAt { get; private set; }

    public string Kind { get; private set; } = string.Empty;

    public string Severity { get; private set; } = string.Empty;

    public string? Component { get; private set; }

    public string Detail { get; private set; } = string.Empty;

    public int Count { get; private set; } = 1;

    public static AgentDiagnosticEvent Create(
        Guid id,
        Guid agentId,
        Guid eventId,
        DateTimeOffset at,
        DateTimeOffset receivedAt,
        string kind,
        string severity,
        string? component,
        string detail,
        int count) =>
        new()
        {
            Id = id,
            AgentId = agentId,
            EventId = eventId,
            At = at,
            ReceivedAt = receivedAt,
            Kind = kind,
            Severity = severity,
            Component = component,
            Detail = detail,
            Count = count,
        };
}
