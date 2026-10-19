namespace UniOver.Modules.Devices.Contracts.Agents;

/// <summary>
/// Presença de um agente, só em memória: nada disto vai para o banco. <see cref="AgentVersion"/> e
/// <see cref="Capabilities"/> vêm do <c>agent.hello.v1</c> e ficam vazios até ele chegar.
/// </summary>
public sealed record AgentPresenceInfo(
    string AgentId,
    bool Connected,
    DateTimeOffset? ConnectedSince,
    string? AgentVersion,
    IReadOnlyList<string> Capabilities,
    DateTimeOffset? LastMessageAt);

/// <summary>Consulta a presença dos agentes (a escrita é do Devices).</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Naming", "CA1716", Justification = "O nome Get da consulta é parte do contrato público pedido pela tarefa.")]
public interface IAgentPresenceReader
{
    /// <summary>Presença do agente, ou nulo se ele nunca se conectou desde que a API subiu.</summary>
    AgentPresenceInfo? Get(string agentId);

    /// <summary>Todos os agentes vistos desde que a API subiu, conectados ou não.</summary>
    IReadOnlyList<AgentPresenceInfo> All();
}

/// <summary>
/// Quem quer saber, na hora, quando a presença de um agente muda (conectou, caiu, mandou o <c>hello</c>). Em processo
/// e sem estado no banco: o ouvinte é chamado dentro da conexão do agente, então deve só enfileirar e voltar.
/// </summary>
public interface IAgentPresenceListener
{
    void OnPresenceChanged(AgentPresenceInfo info);
}
