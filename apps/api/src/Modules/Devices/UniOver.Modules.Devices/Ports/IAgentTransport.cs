namespace UniOver.Modules.Devices.Ports;

/// <summary>Por que o núcleo fecha uma sessão; cada transporte traduz o motivo para o seu jeito de fechar (código WebSocket, desconexão MQTT...).</summary>
public enum AgentCloseReason
{
    /// <summary>Fim normal: o agente saiu ou a leitura terminou.</summary>
    Normal,

    /// <summary>Outra conexão do mesmo agente tomou o lugar desta (um dono da conexão por agente).</summary>
    Replaced,

    /// <summary>Uma versão nova do mesmo agente assumiu a conexão e esta deve encerrar sem reconectar.</summary>
    Handover,

    /// <summary>O agente foi revogado: o token dele deixou de valer.</summary>
    Revoked,

    /// <summary>O agente insistiu em mensagens fora do contrato.</summary>
    PolicyViolation,

    /// <summary>A API está parando.</summary>
    Shutdown,

    /// <summary>
    /// A API está trocando de instância (publicação) e o agente deve reconectar já. Só para quem declarou a capacidade
    /// <c>transport.restart.v1</c>; os demais recebem <see cref="Shutdown"/>.
    /// </summary>
    ServerRestart,

    /// <summary>Falha interna ao tratar a sessão.</summary>
    InternalError,
}

/// <summary>
/// Uma conexão de agente já autenticada pelo transporte. Não expõe nenhum tipo de WebSocket: o núcleo só conhece
/// bytes de JSON e motivos de fechamento, e por isso trocar de transporte é trocar o adaptador.
/// </summary>
public interface IAgentSession : IAsyncDisposable
{
    /// <summary>Slug do agente (o mesmo do <c>source</c> do envelope, sem o prefixo <c>agent:</c>).</summary>
    string AgentId { get; }

    /// <summary>
    /// A conexão se apresentou, no upgrade, como CANDIDATA a assumir a do mesmo agente (passagem de uma versão para a
    /// seguinte, sem queda). Candidata não é roteável nem fecha a antiga: só vira a atual com um <c>agent.hello.v1</c> válido
    /// de passagem. Uma conexão comum (inclusive a que volta depois de um 4411) substitui a anterior na hora.
    /// </summary>
    bool IsHandoverCandidate => false;

    /// <summary>
    /// Próxima mensagem inteira (JSON em UTF-8), ou <c>null</c> quando a sessão acabou. O transporte recusa por conta
    /// própria o que não é mensagem de texto e o que passa do tamanho máximo, fechando a sessão.
    /// </summary>
    ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken);

    /// <summary>Entrega o envelope ao agente. <c>false</c> quando a sessão já fechou ou não consegue acompanhar (fila cheia: ela é fechada).</summary>
    ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken);

    /// <summary>
    /// Como <see cref="SendAsync(ReadOnlyMemory{byte}, CancellationToken)"/>, dizendo se o envelope pode ser descartado
    /// (<paramref name="droppable"/>: um movimento puro do mouse, sem rolagem). O movimento é relativo: descartá-lo muda a
    /// posição final do ponteiro, troca aceita para ele não chegar em rajada atrasada. O transporte que sabe descartar o faz
    /// quando ele envelhece na fila ou quando ela está quase cheia, devolvendo <c>true</c> e mantendo a conexão; o que não sabe
    /// trata como qualquer outro.
    /// </summary>
    ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, bool droppable, CancellationToken cancellationToken) =>
        SendAsync(envelope, cancellationToken);

    /// <summary>Fecha a sessão com o motivo. Pode ser chamado mais de uma vez; as seguintes não fazem nada.</summary>
    Task CloseAsync(AgentCloseReason reason, CancellationToken cancellationToken);
}

/// <summary>
/// O que o núcleo precisa de qualquer transporte: entregar as sessões que ele autenticou. O WebSocket é o primeiro
/// adaptador; o MQTT entra depois como projeto irmão, implementando esta mesma porta.
/// </summary>
public interface IAgentTransport
{
    string Name { get; }

    /// <summary>As sessões autenticadas, conforme chegam. A sequência termina quando <paramref name="cancellationToken"/> é cancelado.</summary>
    IAsyncEnumerable<IAgentSession> AcceptSessionsAsync(CancellationToken cancellationToken);
}

/// <summary>Fecha a sessão local de um agente revogado sem depender da entrega assíncrona da outbox.</summary>
public interface IAgentSessionCloser
{
    Task CloseAsync(string agentId, AgentCloseReason reason, CancellationToken cancellationToken);
}
