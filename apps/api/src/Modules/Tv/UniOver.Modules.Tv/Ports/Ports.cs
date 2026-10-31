using System.Text.Json;
using UniOver.BuildingBlocks.Web;
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

/// <summary>O que a limpeza da TV fez, como o agente relatou (<c>tv.cleanup.result.v1</c>). Memória em MB.</summary>
public sealed record TvCleanupReport(
    int ClosedApps, int? MemoryBeforeMb, int? MemoryAfterMb, int? FreedMb, IReadOnlyList<string> FailedSteps,
    IReadOnlyList<string>? ClosedPackages = null);

/// <summary>Uma limpeza em andamento: o pedido e a espera pelo relatório do agente. Descartar libera a vez.</summary>
public interface ITvCleanupTicket : IDisposable
{
    /// <summary>O que vai no corpo de <c>tv.cleanup.v1</c> e volta no relatório.</summary>
    Guid RequestId { get; }

    /// <summary>
    /// Espera o relatório deste pedido. O agente o manda antes do resultado do comando, então normalmente já chegou;
    /// <paramref name="grace"/> só cobre uma ordem trocada. Nulo se não chegou.
    /// </summary>
    Task<TvCleanupReport?> WaitAsync(TimeSpan grace, CancellationToken cancellationToken);
}

/// <summary>
/// Junta o relatório que o agente manda por iniciativa própria ao pedido HTTP que o espera, e garante uma limpeza por
/// vez em cada TV. Em memória, da instância do contêiner.
/// </summary>
public interface ITvCleanupReports
{
    /// <summary>Começa uma limpeza na TV; nulo se ela já tem outra em andamento.</summary>
    ITvCleanupTicket? TryBegin(Guid tvId);

    /// <summary>Entrega o relatório à limpeza da TV e do <paramref name="requestId"/>; ignora o que ninguém espera.</summary>
    void Complete(Guid tvId, Guid requestId, TvCleanupReport report);
}

/// <summary>Os atalhos como a tela os vê, lidos do banco.</summary>
public interface ITvShortcutReader
{
    Task<IReadOnlyList<TvShortcut>> ListAsync(Guid tvId, CancellationToken cancellationToken);
}

/// <summary>Empurra mudanças para os fluxos SSE abertos (a tela).</summary>
public interface ITvStreamPublisher
{
    void PublishState(TvState state);

    void PublishShortcuts(IReadOnlyList<TvShortcut> shortcuts);

    void PublishWatchdog(TvWatchdogEntry entry);

    // As implementações antigas continuam válidas nos testes; o adaptador real sobrescreve para isolar cada TV.
    void PublishState(Guid tvId, TvState state) => PublishState(state);

    void PublishShortcuts(Guid tvId, IReadOnlyList<TvShortcut> shortcuts) => PublishShortcuts(shortcuts);

    void PublishWatchdog(Guid tvId, TvWatchdogEntry entry) => PublishWatchdog(entry);

    /// <summary>
    /// Sem linha de TV a tela abre o fluxo "sem identificador". Quando a linha é criada, essas telas já abertas passam a
    /// ouvir o fluxo da TV nova, senão ficariam surdas até recarregar. Sem efeito nas implementações de teste.
    /// </summary>
    void AdoptUnidentifiedStream(Guid tvId)
    {
    }
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

    /// <summary>Desde quando o agente está fora (instante da queda ou do último sinal); nulo se conectado ou desconhecido.</summary>
    DateTimeOffset? OfflineSince(string agentId);

    /// <summary>
    /// O agente está sem sessão há mais que a janela de reconexão do gateway. Dentro da janela é só uma queda curta
    /// (o agente volta em um ou dois segundos) e o comando deve esperar a sessão voltar, não falhar.
    /// </summary>
    bool IsOfflineBeyondReconnectGrace(string agentId);
}

/// <summary>
/// Uma TV que o agente achou na rede local dele (<c>tv.discovery.v1</c>). O <c>Id</c> é opaco e estável (o agente o
/// deriva do identificador da TV): nunca é um endereço IP nem um MAC, e nada de rede sai da API.
/// </summary>
public sealed record TvNearby(string Id, string Kind, string? Name, bool Controlled);

/// <summary>Uma procura de TVs em andamento: o pedido e a espera pela lista do agente. Descartar libera a vez.</summary>
public interface ITvDiscoveryTicket : IDisposable
{
    /// <summary>O que vai no corpo de <c>tv.discover.v1</c> e volta na lista.</summary>
    Guid RequestId { get; }

    /// <summary>Espera a lista deste pedido; nula se não chegou a tempo.</summary>
    Task<IReadOnlyList<TvNearby>?> WaitAsync(TimeSpan grace, CancellationToken cancellationToken);
}

/// <summary>
/// Junta a lista que o agente manda por iniciativa própria ao pedido HTTP que a espera, uma procura por computador
/// (duas no mesmo computador disputariam a mesma varredura). Em memória, da instância do contêiner.
/// </summary>
public interface ITvDiscoveryReports
{
    /// <summary>Começa uma procura no computador; nulo se ele já tem outra em andamento.</summary>
    ITvDiscoveryTicket? TryBegin(string agentId);

    /// <summary>Entrega a lista à procura do computador e do <paramref name="requestId"/>; ignora o que ninguém espera.</summary>
    void Complete(string agentId, Guid requestId, IReadOnlyList<TvNearby> tvs);
}
