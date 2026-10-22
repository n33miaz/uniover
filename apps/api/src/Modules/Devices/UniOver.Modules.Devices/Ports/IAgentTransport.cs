namespace UniOver.Modules.Devices.Ports;

/// <summary>Por que o núcleo fecha uma sessão; cada transporte traduz o motivo para o seu jeito de fechar (código WebSocket, desconexão MQTT...).</summary>
public enum AgentCloseReason
{
    /// <summary>Fim normal: o agente saiu ou a leitura terminou.</summary>
    Normal,

    /// <summary>Outra conexão do mesmo agente tomou o lugar desta (um dono da conexão por agente).</summary>
    Replaced,

    /// <summary>O agente foi revogado: o token dele deixou de valer.</summary>
    Revoked,

    /// <summary>O agente insistiu em mensagens fora do contrato.</summary>
    PolicyViolation,

    /// <summary>A API está parando.</summary>
    Shutdown,

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
    /// Próxima mensagem inteira (JSON em UTF-8), ou <c>null</c> quando a sessão acabou. O transporte recusa por conta
    /// própria o que não é mensagem de texto e o que passa do tamanho máximo, fechando a sessão.
    /// </summary>
    ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken);

    /// <summary>Entrega o envelope ao agente. <c>false</c> quando a sessão já fechou ou não consegue acompanhar (fila cheia: ela é fechada).</summary>
    ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken);

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
