using System.Text.Json;
using UniOver.Modules.Tv.Domain;

namespace UniOver.Modules.Tv.Ports;

/// <summary>Uma mensagem para o agente: só o <c>type</c> do contrato e o corpo (o envelope é do Devices).</summary>
public sealed record TvMessage(string Type, JsonElement Body);

public enum TvSendStatus
{
    Delivered,

    /// <summary>Nenhum agente configurado para controlar a TV.</summary>
    NotConfigured,

    AgentOffline,
    AgentTimeout,

    /// <summary>O agente respondeu, mas não conseguiu executar (<c>ok:false</c>).</summary>
    CommandFailed,

    /// <summary>A mensagem montada não cumpre o contrato: erro nosso, não do agente.</summary>
    InvalidMessage,
}

/// <summary>Resultado de entregar uma mensagem ao agente.</summary>
public sealed record TvSendOutcome(TvSendStatus Status, string? ErrorCode, string? ErrorMessage, TimeSpan Latency)
{
    public bool IsDelivered => Status == TvSendStatus.Delivered;

    public static TvSendOutcome Ok(TimeSpan latency) => new(TvSendStatus.Delivered, null, null, latency);

    public static TvSendOutcome Failed(TvSendStatus status, string? code = null, string? message = null, TimeSpan latency = default) =>
        new(status, code, message, latency);
}

/// <summary>Como o módulo manda comandos ao agente que controla a TV (hoje pelo Devices, em processo).</summary>
public interface ITvCommandSender
{
    /// <summary>Envia e espera a resposta do agente.</summary>
    Task<TvSendOutcome> RequestAsync(string agentId, TvMessage message, TimeSpan timeout, CancellationToken cancellationToken);

    /// <summary>Envia sem esperar resposta.</summary>
    Task<TvSendOutcome> PostAsync(string agentId, TvMessage message, CancellationToken cancellationToken);
}

/// <summary>
/// Estado da TV em memória (o volume só existe aqui). Atrás de porta porque cache em memória é do módulo e nunca
/// estático; a instância é do contêiner.
/// </summary>
public interface ITvStateStore
{
    TvStateSnapshot? Last(string agentId);

    void Apply(string agentId, TvStateSnapshot snapshot);

    /// <summary>Anota se o agente está conectado; devolve <c>true</c> quando isso mudou desde a última anotação.</summary>
    bool NoteOnline(string agentId, bool online);
}

/// <summary>Grava a trilha de auditoria de comandos.</summary>
public interface ITvCommandAudit
{
    Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken);
}

/// <summary>Os atalhos como a tela os vê, lidos do banco.</summary>
public interface ITvShortcutReader
{
    Task<IReadOnlyList<TvShortcut>> ListAsync(CancellationToken cancellationToken);
}

/// <summary>Empurra mudanças para os fluxos SSE abertos (a tela).</summary>
public interface ITvStreamPublisher
{
    void PublishState(TvState state);

    void PublishShortcuts(IReadOnlyList<TvShortcut> shortcuts);

    void PublishWatchdog(TvWatchdogEntry entry);
}

/// <summary>Evento do vigia como a tela o recebe.</summary>
public sealed record TvWatchdogEntry(
    string Kind,
    string Severity,
    string Detail,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.Strict)] int Attempts,
    DateTimeOffset At);

/// <summary>Quem sabe se o agente que controla a TV está conectado (a presença é do Devices).</summary>
public interface ITvAgentPresence
{
    bool IsOnline(string agentId);
}
