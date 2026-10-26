using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.Modules.Devices.Ports;

/// <summary>
/// Onde a presença viva mora: memória do processo (<c>InMemoryPresenceStore</c>). O retrato persistido é escrito por
/// outro serviço, com intervalo entre batimentos, para esta porta continuar isolando o estado instantâneo do módulo.
/// </summary>
internal interface IPresenceStore
{
    /// <summary>Marca o agente como conectado; versão e capacidades voltam a vazio até o próximo <c>agent.hello.v1</c>.</summary>
    AgentPresenceInfo MarkConnected(string agentId, DateTimeOffset now);

    /// <summary>Marca como desconectado, mantendo o que se sabia dele; nulo se ele nunca foi visto.</summary>
    AgentPresenceInfo? MarkDisconnected(string agentId, DateTimeOffset now);

    /// <summary>Guarda versão, capacidades e dados do PC do <c>agent.hello.v1</c>; nulo se o agente não está conectado.</summary>
    AgentPresenceInfo? RecordHello(
        string agentId,
        string agentVersion,
        IReadOnlyList<string> capabilities,
        DateTimeOffset now,
        AgentHostInfo? host = null,
        AgentUpdateInfo? update = null);

    /// <summary>Guarda o estado da auto-atualização (<c>agent.update.status.v1</c>); não é mudança de presença, ninguém é notificado.</summary>
    void RecordUpdate(string agentId, AgentUpdateInfo update, DateTimeOffset now);

    /// <summary>Só anota o instante da última mensagem (não é mudança de estado: ninguém é notificado).</summary>
    void Touch(string agentId, DateTimeOffset now);

    AgentPresenceInfo? Get(string agentId);

    IReadOnlyList<AgentPresenceInfo> All();
}
