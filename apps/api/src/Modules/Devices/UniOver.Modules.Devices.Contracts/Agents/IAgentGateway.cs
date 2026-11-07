using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Contracts.Agents;

/// <summary>
/// Como os outros módulos falam com um agente. Hoje roda em processo sobre o transporte ativo (WebSocket);
/// amanhã pode ser um cliente HTTP ou outro transporte sem mudar quem chama.
/// </summary>
public interface IAgentGateway
{
    /// <summary>
    /// Envia sem esperar resposta. Falhas: <c>agent_offline</c> e <c>invalid_message</c>. Sem sessão viva, espera a janela
    /// de reconexão, a não ser que a mensagem peça <see cref="AgentDelivery.Immediate"/>.
    /// </summary>
    Task<Result> SendAsync(string agentId, OutboundMessage message, CancellationToken cancellationToken = default);

    /// <summary>
    /// Envia e espera o <c>command.result.v1</c> que aponta para este comando. Falhas: <c>agent_offline</c> (depois da
    /// janela de reconexão, ou na hora com <see cref="AgentDelivery.Immediate"/>), <c>agent_timeout</c> e <c>invalid_message</c>.
    /// </summary>
    Task<Result<AgentReply>> RequestAsync(
        string agentId, OutboundMessage message, TimeSpan timeout, CancellationToken cancellationToken = default);
}
