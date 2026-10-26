using System.Diagnostics;
using System.Net.WebSockets;
using AwesomeAssertions;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Ports;
using UniOver.Modules.Devices.Transport.WebSocket;

namespace UniOver.Modules.Devices.Tests.Transport;

/// <summary>
/// Soquete que só faz o que o teste manda: o envio pode ficar pendurado sem falhar (agente que parou de ler, buffer de
/// TCP cheio) e o outro lado só responde ao fechamento quando o teste quer. Nada de rede.
/// </summary>
internal sealed class FakeWebSocket(bool sendHangs, bool abortUnblocksSend) : System.Net.WebSockets.WebSocket
{
    private readonly TaskCompletionSource _sendStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _sendGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<WebSocketReceiveResult> _incoming = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<byte[]> _sent = [];
    private readonly List<(WebSocketCloseStatus Status, string? Reason)> _closes = [];
    private WebSocketState _state = WebSocketState.Open;
    private int _abortCalls;

    public override WebSocketCloseStatus? CloseStatus => null;

    public override string? CloseStatusDescription => null;

    public override WebSocketState State => _state;

    public override string? SubProtocol => null;

    /// <summary>Completa quando o escritor da sessão entrou no envio (e, portanto, segura o cadeado de escrita).</summary>
    public Task SendStarted => _sendStarted.Task;

    public int AbortCalls => Volatile.Read(ref _abortCalls);

    public IReadOnlyList<byte[]> Sent => _sent;

    public IReadOnlyList<(WebSocketCloseStatus Status, string? Reason)> Closes => _closes;

    /// <summary>O agente "responde" ao fechamento: o próximo <c>ReceiveAsync</c> devolve o quadro de fechamento.</summary>
    public void PeerClosesOutput()
    {
        _state = _state == WebSocketState.CloseSent ? _state : WebSocketState.CloseReceived;
        _incoming.TrySetResult(new WebSocketReceiveResult(0, WebSocketMessageType.Close, true, WebSocketCloseStatus.NormalClosure, "bye"));
    }

    /// <summary>Solta um envio pendurado (para o teste não deixar tarefa presa quando ele falha).</summary>
    public void ReleaseSend() => _sendGate.TrySetResult();

    public override void Abort()
    {
        Interlocked.Increment(ref _abortCalls);
        _state = WebSocketState.Aborted;
        _incoming.TrySetException(new WebSocketException(WebSocketError.ConnectionClosedPrematurely));
        if (abortUnblocksSend)
        {
            _sendGate.TrySetException(new WebSocketException(WebSocketError.ConnectionClosedPrematurely));
        }
    }

    public override async Task SendAsync(
        ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
    {
        _sendStarted.TrySetResult();
        if (sendHangs)
        {
            // Ignora o token de propósito: é o pior caso, um envio que nem o cancelamento solta.
            await _sendGate.Task;
        }

        _sent.Add(buffer.ToArray());
    }

    public override async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
    {
        var result = await _incoming.Task.WaitAsync(cancellationToken);
        if (result.MessageType == WebSocketMessageType.Close && _state == WebSocketState.CloseSent)
        {
            _state = WebSocketState.Closed;
        }

        return result;
    }

    public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
    {
        _closes.Add((closeStatus, statusDescription));
        _state = _state == WebSocketState.CloseReceived ? WebSocketState.Closed : WebSocketState.CloseSent;
        return Task.CompletedTask;
    }

    public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) =>
        CloseOutputAsync(closeStatus, statusDescription, cancellationToken);

    public override void Dispose()
    {
    }
}

/// <summary>
/// O fechamento da sessão do agente nunca fica sem prazo: um envio que não termina nem falha (agente que parou de ler)
/// não pode segurar a revogação ou a substituição da sessão para sempre.
/// </summary>
public sealed class WebSocketSessionCloseTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly DevicesTransportOptions OneSecondGrace = new() { CloseGraceSeconds = 1 };

    /// <summary>Folga sobre a graça para o agendamento da máquina de teste; o fechamento preso demoraria para sempre.</summary>
    private static readonly TimeSpan Slack = TimeSpan.FromMilliseconds(1500);

    private static readonly byte[] Frame = "{}"u8.ToArray();

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Close_WhenTheWriterIsStuckInASend_AbortsTheSocketWithinTheGrace_AndTheSessionIsReleased(bool abortUnblocksSend)
    {
        var socket = new FakeWebSocket(sendHangs: true, abortUnblocksSend);
        await using var session = new WebSocketAgentSession("pc-casa", socket, OneSecondGrace);
        try
        {
            (await session.SendAsync(Frame, TestContext.Current.CancellationToken)).Should().BeTrue();
            await socket.SendStarted.WaitAsync(Patience, TestContext.Current.CancellationToken);

            var clock = Stopwatch.StartNew();
            await session.CloseAsync(AgentCloseReason.Revoked, CancellationToken.None).WaitAsync(Patience, TestContext.Current.CancellationToken);

            clock.Elapsed.Should().BeLessThan(OneSecondGrace.CloseGrace + Slack, "o cadeado de escrita também tem prazo");
            socket.AbortCalls.Should().BeGreaterThan(0, "sem conseguir fechar com educação, derruba a conexão");
            socket.State.Should().Be(WebSocketState.Aborted);

            // A leitura que ficaria presa num socket derrubado é liberada, e a sessão pode ser descartada e concluída.
            await session.DisposeAsync().AsTask().WaitAsync(Patience, TestContext.Current.CancellationToken);
            await session.Completion.WaitAsync(Patience, TestContext.Current.CancellationToken);
        }
        finally
        {
            socket.ReleaseSend();
        }
    }

    [Fact]
    public async Task AnswerClose_WhenTheWriterIsStuckInASend_DoesNotHoldTheReaderForever()
    {
        var socket = new FakeWebSocket(sendHangs: true, abortUnblocksSend: false);
        await using var session = new WebSocketAgentSession("pc-casa", socket, OneSecondGrace);
        try
        {
            (await session.SendAsync(Frame, TestContext.Current.CancellationToken)).Should().BeTrue();
            await socket.SendStarted.WaitAsync(Patience, TestContext.Current.CancellationToken);

            // O agente pede o fechamento enquanto o escritor está preso: o leitor responde ao quadro e termina.
            socket.PeerClosesOutput();
            var clock = Stopwatch.StartNew();
            var read = await session.ReceiveAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(Patience, TestContext.Current.CancellationToken);

            read.Should().BeNull();
            clock.Elapsed.Should().BeLessThan(OneSecondGrace.CloseGrace + Slack);
            socket.AbortCalls.Should().BeGreaterThan(0);
        }
        finally
        {
            socket.ReleaseSend();
        }
    }

    [Fact]
    public async Task Close_WhenTheWriterIsIdle_DeliversTheQueuedFrameAndClosesWithTheCodeWithoutAborting()
    {
        var socket = new FakeWebSocket(sendHangs: false, abortUnblocksSend: false);
        await using var session = new WebSocketAgentSession("pc-casa", socket, OneSecondGrace);
        (await session.SendAsync(Frame, TestContext.Current.CancellationToken)).Should().BeTrue();

        await session.CloseAsync(AgentCloseReason.Revoked, CancellationToken.None).WaitAsync(Patience, TestContext.Current.CancellationToken);

        socket.Sent.Should().ContainSingle("a resposta que já estava na fila precede o fechamento");
        socket.Closes.Should().Equal([((WebSocketCloseStatus)4403, "revoked")]);
        socket.AbortCalls.Should().Be(0, "o caminho normal não derruba a conexão");

        // O agente responde ao fechamento: o descarte termina sem esperar a graça inteira e sem abortar.
        socket.PeerClosesOutput();
        var clock = Stopwatch.StartNew();
        await session.DisposeAsync().AsTask().WaitAsync(Patience, TestContext.Current.CancellationToken);
        clock.Elapsed.Should().BeLessThan(OneSecondGrace.CloseGrace);
    }
}
