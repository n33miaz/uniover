using System.Text.Json.Serialization;

namespace UniOver.Modules.Devices.Contracts.Agents;

/// <summary>
/// O que o <c>agent.hello.v1</c> conta do PC além da versão e das capacidades: sistema e a TV que ele controla. É
/// informação do administrador (manutenção remota): nunca sai nos eventos de presença, só na lista dos agentes dele.
/// </summary>
/// <param name="Os">Sistema do PC, texto curto (por exemplo <c>Windows 11 (10.0.26200)</c>).</param>
/// <param name="TvKind"><c>android</c> ou <c>samsung</c>.</param>
/// <param name="TvHost">Endereço da TV na rede do PC.</param>
public sealed record AgentHostInfo(string? Os, string? TvKind, string? TvHost);

/// <summary>
/// O que o agente conta da própria auto-atualização (<c>update</c> do <c>hello</c> e <c>agent.update.status.v1</c>). Só
/// informativo, e só na lista do administrador. Os <c>sha</c> são o commit inteiro; os horários, UTC.
/// </summary>
/// <param name="Outcome"><c>not_checked</c>, <c>updating</c>, <c>updated</c>, <c>up_to_date</c>, <c>failed</c>, <c>blocked</c> ou <c>rolled_back</c>.</param>
/// <param name="InstalledSha">Commit instalado.</param>
/// <param name="InstalledAt">Quando essa versão foi instalada.</param>
/// <param name="LatestSha">O commit mais novo que a última checagem viu na <c>main</c>.</param>
/// <param name="CheckedAt">Quando a última checagem rodou.</param>
/// <param name="NextCheckAt">Quando o supervisor checa de novo.</param>
/// <param name="Reason">Motivo curto da falha (o agente já tirou segredos).</param>
/// <param name="BlockedSha">Versão que caiu repetidamente e não será instalada de novo.</param>
/// <param name="PreviousSha">Versão guardada para voltar atrás (<c>app.previous</c>), se houver.</param>
/// <param name="RolledBack">Houve volta à versão anterior.</param>
public sealed record AgentUpdateInfo(
    string Outcome,
    string? InstalledSha,
    DateTimeOffset? InstalledAt,
    string? LatestSha,
    DateTimeOffset? CheckedAt,
    DateTimeOffset? NextCheckAt,
    string? Reason,
    string? BlockedSha,
    string? PreviousSha,
    bool RolledBack);

/// <summary>
/// Presença viva de um agente (conexão, em memória). O último contato, a versão e a situação de atualização também são
/// guardados no banco, num resumo à parte, para valerem com o agente desligado. <see cref="AgentVersion"/> e
/// <see cref="Capabilities"/> vêm do <c>agent.hello.v1</c> e ficam vazios até ele chegar. <see cref="DisconnectedAt"/>
/// é o instante em que a sessão caiu (nulo enquanto conectado).
/// </summary>
public sealed record AgentPresenceInfo(
    string AgentId,
    bool Connected,
    DateTimeOffset? ConnectedSince,
    string? AgentVersion,
    IReadOnlyList<string> Capabilities,
    DateTimeOffset? LastMessageAt,
    DateTimeOffset? DisconnectedAt = null,
    [property: JsonIgnore] AgentHostInfo? Host = null,
    [property: JsonIgnore] AgentUpdateInfo? Update = null);

/// <summary>Consulta a presença dos agentes (a escrita é do Devices).</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Naming", "CA1716", Justification = "O nome Get da consulta é parte do contrato público pedido pela tarefa.")]
public interface IAgentPresenceReader
{
    /// <summary>Presença do agente, ou nulo se ele nunca se conectou desde que a API subiu.</summary>
    AgentPresenceInfo? Get(string agentId);

    /// <summary>Todos os agentes vistos desde que a API subiu, conectados ou não.</summary>
    IReadOnlyList<AgentPresenceInfo> All();

    /// <summary>Quanto um comando tolera o agente reaparecer depois de uma reconexão curta (a janela do gateway).</summary>
    TimeSpan ReconnectGrace { get; }

    /// <summary>
    /// Desde quando o agente está sem sessão: o instante da queda, ou, se nunca se conectou desde que a API subiu, o
    /// instante em que a presença passou a valer. Nulo se ele está conectado.
    /// </summary>
    DateTimeOffset? OfflineSince(string agentId);
}

/// <summary>
/// Quem quer saber, na hora, quando a presença de um agente muda (conectou, caiu, mandou o <c>hello</c>). Em processo
/// e sem estado no banco: o ouvinte é chamado dentro da conexão do agente, então deve só enfileirar e voltar.
/// </summary>
public interface IAgentPresenceListener
{
    void OnPresenceChanged(AgentPresenceInfo info);
}
