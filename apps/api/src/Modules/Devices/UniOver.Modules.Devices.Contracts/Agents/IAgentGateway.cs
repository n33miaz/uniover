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
    /// de reconexão; com <see cref="AgentDelivery.Immediate"/> só a espera curta de quem acabou de cair. Um movimento puro do mouse
    /// (sem rolagem) que não cabe mais na fila de saída, ou que envelheceu nela, é descartado e conta como entregue. O movimento
    /// é relativo: descartá-lo muda a posição final do ponteiro, troca aceita para o mouse não chegar em rajada atrasada.
    /// </summary>
    Task<Result> SendAsync(string agentId, OutboundMessage message, CancellationToken cancellationToken = default);

    /// <summary>
    /// Envia e espera o <c>command.result.v1</c> que aponta para este comando. Falhas: <c>agent_offline</c> (depois da
    /// janela de reconexão, ou da espera curta com <see cref="AgentDelivery.Immediate"/>), <c>agent_timeout</c>, <c>invalid_message</c>
    /// e <c>agent_stalled</c> (conectado, mas mudo: nada é enviado e a falha volta na hora; a soltura de botão ou tecla,
    /// <c>action: UP</c>, sempre sai).
    /// </summary>
    Task<Result<AgentReply>> RequestAsync(
        string agentId, OutboundMessage message, TimeSpan timeout, CancellationToken cancellationToken = default);
}
