using AwesomeAssertions;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Transport.WebSocket;

namespace UniOver.Modules.Devices.Tests.Transport;

/// <summary>
/// O agente que parou de ler (PC paginado) com o mouse em uso: os movimentos não derrubam mais a conexão com 1013. Os que não
/// cabem são descartados, os que envelheceram na fila não saem, e os cliques e as teclas continuam tendo lugar, na ordem.
/// </summary>
public sealed class WebSocketStaleInputTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly DevicesTransportOptions SmallQueue = new()
    {
        QueueCapacity = 8,
        StaleInputMilliseconds = 100,
        CloseGraceSeconds = 1,
    };

    private static byte[] Frame(string type) => System.Text.Encoding.UTF8.GetBytes($$"""{"type":"{{type}}"}""");

    [Fact]
    public async Task PointerMovesNeverCloseTheConnection_OldOnesAreDropped_AndClicksStillGoOut()
    {
        var socket = new FakeWebSocket(sendHangs: true, abortUnblocksSend: true);
        await using var session = new WebSocketAgentSession("pc-casa", socket, SmallQueue);

        // O primeiro envio fica preso (o agente parou de ler): tudo o que vem depois fica na fila.
        (await session.SendAsync(Frame("pc.click.v2"), CancellationToken.None)).Should().BeTrue();
        await socket.SendStarted.WaitAsync(Patience, TestContext.Current.CancellationToken);

        // Uma rajada de movimentos bem maior que a fila: nenhum derruba a conexão.
        for (var i = 0; i < 50; i++)
        {
            (await session.SendAsync(Frame("pc.pointer.v1"), droppable: true, CancellationToken.None)).Should().BeTrue();
        }

        // Os movimentos ocupam no máximo três quartos da fila: o clique seguinte ainda cabe, depois dos movimentos já na fila.
        (await session.SendAsync(Frame("pc.key.v2"), CancellationToken.None)).Should().BeTrue();
        socket.Closes.Should().BeEmpty("movimento do mouse não é motivo para fechar com 1013");

        // O agente volta depois de os movimentos envelhecerem: só o clique e a tecla saem, na ordem.
        await Task.Delay(300, TestContext.Current.CancellationToken);
        socket.ReleaseSend();
        var deadline = DateTime.UtcNow + Patience;
        while (socket.Sent.Count < 2 && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20, TestContext.Current.CancellationToken);
        }

        await Task.Delay(100, TestContext.Current.CancellationToken);
        socket.Sent.Select(System.Text.Encoding.UTF8.GetString).Should().Equal(
            """{"type":"pc.click.v2"}""", """{"type":"pc.key.v2"}""");
    }

    [Fact]
    public async Task FreshPointerMoves_StillGoOut()
    {
        var socket = new FakeWebSocket(sendHangs: false, abortUnblocksSend: true);
        await using var session = new WebSocketAgentSession("pc-casa", socket, SmallQueue);

        (await session.SendAsync(Frame("pc.pointer.v1"), droppable: true, CancellationToken.None)).Should().BeTrue();
        var deadline = DateTime.UtcNow + Patience;
        while (socket.Sent.Count < 1 && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20, TestContext.Current.CancellationToken);
        }

        socket.Sent.Should().ContainSingle();
    }

    [Fact]
    public async Task OtherEnvelopes_StillCloseTheConnection_WhenTheAgentDoesNotKeepUp()
    {
        var socket = new FakeWebSocket(sendHangs: true, abortUnblocksSend: true);
        await using var session = new WebSocketAgentSession("pc-casa", socket, SmallQueue);
        (await session.SendAsync(Frame("tv.key.v1"), CancellationToken.None)).Should().BeTrue();
        await socket.SendStarted.WaitAsync(Patience, TestContext.Current.CancellationToken);

        var accepted = 0;
        for (var i = 0; i < 20; i++)
        {
            if (await session.SendAsync(Frame("tv.key.v1"), CancellationToken.None))
            {
                accepted++;
            }
        }

        accepted.Should().Be(SmallQueue.QueueCapacity, "o comportamento de antes vale para o que não é movimento");
    }
}
