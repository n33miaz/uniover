using System.Net.WebSockets;
using System.Threading.Channels;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Ports;

namespace UniOver.Modules.Devices.Transport.WebSocket;

/// <summary>
/// Códigos de fechamento que o adaptador usa. Os de aplicação ficam na faixa 4000-4999; o agente decide pelo
/// motivo (texto) e pelo código: <c>revoked</c> (4403) para de reconectar, <c>replaced</c> (4409) espera antes de tentar de novo.
/// </summary>
internal static class CloseCodes
{
    public const WebSocketCloseStatus Replaced = (WebSocketCloseStatus)4409;
    public const WebSocketCloseStatus Revoked = (WebSocketCloseStatus)4403;
    public const WebSocketCloseStatus QueueFull = (WebSocketCloseStatus)1013;

    public static (WebSocketCloseStatus Status, string Reason) For(AgentCloseReason reason) => reason switch
    {
        AgentCloseReason.Replaced => (Replaced, "replaced"),
        AgentCloseReason.Revoked => (Revoked, "revoked"),
        AgentCloseReason.PolicyViolation => (WebSocketCloseStatus.PolicyViolation, "policy_violation"),
        AgentCloseReason.Shutdown => ((WebSocketCloseStatus)1012, "service_restart"),
        AgentCloseReason.InternalError => (WebSocketCloseStatus.InternalServerError, "internal_error"),
        _ => (WebSocketCloseStatus.NormalClosure, "closed"),
    };
}

/// <summary>
/// Uma conexão WebSocket de agente. Um leitor (o núcleo, por <see cref="ReceiveAsync"/>) e um escritor (a tarefa
/// de saída, alimentada por uma fila limitada); o fechamento passa pelo mesmo cadeado do escritor porque o
/// WebSocket não aceita duas escritas ao mesmo tempo. Só quadros de texto, até o tamanho máximo.
/// </summary>
internal sealed class WebSocketAgentSession : IAgentSession
{
    private readonly System.Net.WebSockets.WebSocket _socket;
    private readonly DevicesTransportOptions _options;
    private readonly Channel<byte[]> _outbound;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly CancellationTokenSource _stop = new();
    private readonly TaskCompletionSource _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly byte[] _buffer = new byte[8192];
    private readonly Task _writer;
    private int _closing;
    private int _disposed;

    public WebSocketAgentSession(string agentId, System.Net.WebSockets.WebSocket socket, DevicesTransportOptions options)
    {
        AgentId = agentId;
        _socket = socket;
        _options = options;
        _outbound = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(options.QueueCapacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
        });
        _writer = Task.Run(WriteLoopAsync);
    }

    public string AgentId { get; }

    /// <summary>Termina quando a sessão foi descartada: o endpoint HTTP só devolve a requisição depois disso.</summary>
    public Task Completion => _completion.Task;

    public async ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken)
    {
        using var message = new MemoryStream();
        while (true)
        {
            ValueWebSocketReceiveResult result;
            try
            {
                result = await _socket.ReceiveAsync(_buffer.AsMemory(), cancellationToken);
            }
            catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException)
            {
                // Conexão derrubada sem o aperto de mão de fechamento.
                return null;
            }

            switch (result.MessageType)
            {
                case WebSocketMessageType.Close:
                    await AnswerCloseAsync();
                    return null;

                case WebSocketMessageType.Binary:
                    await CloseWithAsync(WebSocketCloseStatus.InvalidMessageType, "text_only", CancellationToken.None);
                    return null;
            }

            message.Write(_buffer, 0, result.Count);
            if (message.Length > _options.MaxMessageBytes)
            {
                await CloseWithAsync(WebSocketCloseStatus.MessageTooBig, "message_too_big", CancellationToken.None);
                return null;
            }

            if (result.EndOfMessage)
            {
                return message.ToArray();
            }
        }
    }

    public ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _closing) != 0)
        {
            return ValueTask.FromResult(false);
        }

        if (_outbound.Writer.TryWrite(envelope.ToArray()))
        {
            return ValueTask.FromResult(true);
        }

        // Fila cheia: o agente não acompanha. Fecha em vez de acumular memória.
        _ = CloseWithAsync(CloseCodes.QueueFull, "queue_full", CancellationToken.None);
        return ValueTask.FromResult(false);
    }

    public Task CloseAsync(AgentCloseReason reason, CancellationToken cancellationToken)
    {
        var (status, text) = CloseCodes.For(reason);
        return CloseWithAsync(status, text, cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        await CloseWithAsync(WebSocketCloseStatus.NormalClosure, "closed", CancellationToken.None);
        await AwaitPeerCloseAsync();
        await _stop.CancelAsync();
        _socket.Abort();
        _socket.Dispose();
        _completion.TrySetResult();
    }

    /// <summary>
    /// Depois de fechar do nosso lado, espera o agente responder ao fechamento (até o prazo, em tempo real: é prazo de
    /// E/S, não regra de negócio). Derrubar a conexão antes disso faria o agente ver uma queda em vez do código de fechamento.
    /// </summary>
    private async Task AwaitPeerCloseAsync()
    {
        if (_socket.State != WebSocketState.CloseSent)
        {
            return;
        }

        using var grace = new CancellationTokenSource(_options.CloseGrace);
        try
        {
            while (_socket.State == WebSocketState.CloseSent)
            {
                var result = await _socket.ReceiveAsync(_buffer.AsMemory(), grace.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or ObjectDisposedException)
        {
            // Sem resposta no prazo ou já caiu: segue para derrubar.
        }
    }

    private async Task WriteLoopAsync()
    {
        try
        {
            await foreach (var frame in _outbound.Reader.ReadAllAsync(_stop.Token))
            {
                await _sendLock.WaitAsync(_stop.Token);
                try
                {
                    if (_socket.State != WebSocketState.Open)
                    {
                        return;
                    }

                    await _socket.SendAsync(frame, WebSocketMessageType.Text, true, _stop.Token);
                }
                finally
                {
                    _sendLock.Release();
                }
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or ObjectDisposedException)
        {
            // Conexão caiu ou a sessão foi descartada: o leitor percebe e encerra.
        }
    }

    private async Task CloseWithAsync(WebSocketCloseStatus status, string reason, CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref _closing, 1) != 0)
        {
            return;
        }

        // Deixa a fila de saída esvaziar antes de fechar: a resposta de erro precede o fechamento.
        _outbound.Writer.TryComplete();
        try
        {
            await _writer.WaitAsync(_options.CloseGrace, cancellationToken);
        }
        catch (TimeoutException)
        {
            // Agente sem ler: fecha mesmo assim.
        }

        await _sendLock.WaitAsync(CancellationToken.None);
        try
        {
            if (_socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await _socket.CloseOutputAsync(status, reason, cancellationToken);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            // Já caiu: nada a fechar.
        }
        finally
        {
            _sendLock.Release();
        }

        _ = AbortAfterGraceAsync();
    }

    /// <summary>O agente que não responde ao fechamento é derrubado depois do prazo.</summary>
    private async Task AbortAfterGraceAsync()
    {
        try
        {
            await Task.Delay(_options.CloseGrace, _stop.Token);
            if (_socket.State != WebSocketState.Closed)
            {
                _socket.Abort();
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException)
        {
            // Sessão descartada antes do prazo.
        }
    }

    private async Task AnswerCloseAsync()
    {
        if (Interlocked.Exchange(ref _closing, 1) != 0)
        {
            return;
        }

        _outbound.Writer.TryComplete();
        await _sendLock.WaitAsync(CancellationToken.None);
        try
        {
            if (_socket.State == WebSocketState.CloseReceived)
            {
                await _socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "closed", CancellationToken.None);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException)
        {
            // Já caiu.
        }
        finally
        {
            _sendLock.Release();
        }
    }
}
