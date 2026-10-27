namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// Uma queda de agente: o computador ficou sem sinal por mais que o limite combinado. Há uma por queda (a volta fecha a
/// mesma linha, e uma queda nova abre outra), e é isso que dá "um aviso por queda". Não é trilha de auditoria: a linha
/// muda (volta, visto), e o fato fica registrado à parte em <see cref="PairingAuditEntry"/>.
/// </summary>
public sealed class AgentOutage
{
    // Para o EF Core materializar a linha.
    private AgentOutage()
    {
    }

    public Guid Id { get; private set; }

    public Guid AgentId { get; private set; }

    /// <summary>Quando o monitor percebeu a queda.</summary>
    public DateTimeOffset DetectedAt { get; private set; }

    /// <summary>O último sinal do agente antes de calar (pode ser nulo se o retrato não o tinha).</summary>
    public DateTimeOffset? LastSeenAt { get; private set; }

    /// <summary>Nulo enquanto o agente continua sem sinal.</summary>
    public DateTimeOffset? RecoveredAt { get; private set; }

    /// <summary>Quando o dono viu o aviso (tirou da Início e de Dispositivos).</summary>
    public DateTimeOffset? SeenAt { get; private set; }

    public bool IsOpen => RecoveredAt is null;

    public static AgentOutage Open(Guid id, Guid agentId, DateTimeOffset detectedAt, DateTimeOffset? lastSeenAt) =>
        new() { Id = id, AgentId = agentId, DetectedAt = detectedAt, LastSeenAt = lastSeenAt };

    /// <summary>Fecha a queda; já fechada não muda nada.</summary>
    public bool Recover(DateTimeOffset now)
    {
        if (RecoveredAt is not null)
        {
            return false;
        }

        RecoveredAt = now;
        return true;
    }

    public void MarkSeen(DateTimeOffset now) => SeenAt ??= now;
}
