using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.Modules.Devices.Ports;

/// <summary>
/// Onde a presença mora. Hoje é memória do processo (<c>InMemoryPresenceStore</c>): batimento e presença nunca
/// escrevem no banco, porque cada escrita acordaria o Postgres do plano grátis. Atrás de porta para o estado em
/// memória não vazar para o resto do módulo.
/// </summary>
internal interface IPresenceStore
{
    /// <summary>Marca o agente como conectado; versão e capacidades voltam a vazio até o próximo <c>agent.hello.v1</c>.</summary>
    AgentPresenceInfo MarkConnected(string agentId, DateTimeOffset now);

    /// <summary>Marca como desconectado, mantendo o que se sabia dele; nulo se ele nunca foi visto.</summary>
    AgentPresenceInfo? MarkDisconnected(string agentId);

    /// <summary>Guarda versão e capacidades do <c>agent.hello.v1</c>; nulo se o agente não está conectado.</summary>
    AgentPresenceInfo? RecordHello(string agentId, string agentVersion, IReadOnlyList<string> capabilities, DateTimeOffset now);

    /// <summary>Só anota o instante da última mensagem (não é mudança de estado: ninguém é notificado).</summary>
    void Touch(string agentId, DateTimeOffset now);

    AgentPresenceInfo? Get(string agentId);

    IReadOnlyList<AgentPresenceInfo> All();
}
