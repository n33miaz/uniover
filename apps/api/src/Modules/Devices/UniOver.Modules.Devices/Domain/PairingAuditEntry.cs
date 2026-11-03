using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Domain;

/// <summary>Limites de texto da auditoria (IP e User-Agent vêm do cliente e não podem inflar a tabela).</summary>
public static class AuditText
{
    public const int IpMax = 64;
    public const int UserAgentMax = 256;

    public static string? Truncate(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];
}

/// <summary>Valores da coluna <c>event</c> de <c>pairing_audit</c>: texto estável, lido por quem consulta o banco.</summary>
public static class PairingEvents
{
    public const string Started = "pairing_started";
    public const string Approved = "approved";
    public const string Denied = "denied";
    public const string Expired = "expired";
    public const string TokenIssued = "token_issued";
    public const string AgentRevoked = "agent_revoked";

    // Manutenção remota (só o administrador): ver o registro do agente e pedir que atualize ou reinicie.
    public const string AgentLogsViewed = "agent_logs_viewed";
    public const string AgentUpdateRequested = "agent_update_requested";
    public const string AgentRestartRequested = "agent_restart_requested";
    public const string AgentRollbackRequested = "agent_rollback_requested";

    // Presença do computador: o monitor registra a queda (sem sinal além do limite) e a volta. Sem conta, sem IP.
    public const string AgentOffline = "agent_offline";
    public const string AgentOnline = "agent_online";

    // Controle do PC pelo app: só o que age na energia ou abre programas (movimento e teclas não entram). O nome cabe nos 40
    // caracteres da coluna.
    public const string PcLock = "pc_lock";
    public const string PcSleep = "pc_sleep";
    public const string PcShutdown = "pc_shutdown";
    public const string PcShutdownCancelled = "pc_shutdown_cancelled";
    public const string PcAppLaunch = "pc_app_launch";
}

/// <summary>
/// Uma linha da trilha de auditoria do pareamento: quem, de onde, qual aparelho, qual passo. Nunca guarda o
/// <c>deviceCode</c> nem token algum.
/// </summary>
public sealed class PairingAuditEntry
{
    // Para o EF Core materializar a linha.
    private PairingAuditEntry()
    {
    }

    public Guid Id { get; private set; }

    public string Event { get; private set; } = string.Empty;

    /// <summary>Nulo antes da aprovação (o agente ainda não existe).</summary>
    public Guid? AgentId { get; private set; }

    public Guid? PairingId { get; private set; }

    /// <summary>Nulo nos passos do agente (anônimos).</summary>
    public Guid? UserId { get; private set; }

    public string? Ip { get; private set; }

    public string? UserAgent { get; private set; }

    public DateTimeOffset OccurredAt { get; private set; }

    public static PairingAuditEntry Create(
        string eventName,
        Guid? agentId,
        Guid? pairingId,
        Guid? userId,
        string? ip,
        string? userAgent,
        DateTimeOffset occurredAt)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(eventName);

        return new PairingAuditEntry
        {
            Id = IdGenerator.NewId(),
            Event = eventName,
            AgentId = agentId,
            PairingId = pairingId,
            UserId = userId,
            Ip = AuditText.Truncate(ip, AuditText.IpMax),
            UserAgent = AuditText.Truncate(userAgent, AuditText.UserAgentMax),
            OccurredAt = occurredAt,
        };
    }
}
