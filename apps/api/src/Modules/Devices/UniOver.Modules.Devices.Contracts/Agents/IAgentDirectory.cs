namespace UniOver.Modules.Devices.Contracts.Agents;

/// <summary>
/// Um agente pareado como os outros módulos o enxergam: só o que serve para escolher e conferir. Nada do token, do
/// hash dele, de quem pareou nem do motivo da revogação sai do Devices.
/// </summary>
/// <param name="Slug">O <c>agentId</c> do envelope: identifica o agente em todo o sistema.</param>
/// <param name="Name">O nome amigável que o dono deu ao aparelho no pareamento.</param>
/// <param name="Revoked">Revogado: o token dele não vale mais e a sessão foi encerrada.</param>
public sealed record AgentListing(string Slug, string Name, string Platform, bool Revoked);

/// <summary>
/// Consulta, só leitura, aos agentes pareados (a escrita é do Devices). Existe para um módulo validar um slug que
/// alguém escolheu e oferecer a lista de agentes, sem chave estrangeira entre schemas e sem conhecer o banco do Devices.
/// A presença (conectado ou não) fica em <see cref="IAgentPresenceReader"/>.
/// </summary>
public interface IAgentDirectory
{
    /// <summary>O agente pelo slug (revogado também), ou nulo se esse slug nunca foi pareado.</summary>
    Task<AgentListing?> FindAsync(string slug, CancellationToken cancellationToken = default);

    /// <summary>Os agentes pareados que não foram revogados, do mais antigo ao mais novo.</summary>
    Task<IReadOnlyList<AgentListing>> ListActiveAsync(CancellationToken cancellationToken = default);
}
