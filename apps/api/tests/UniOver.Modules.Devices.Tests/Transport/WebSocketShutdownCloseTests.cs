using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using AwesomeAssertions;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Ports;
using UniOver.Modules.Devices.Transport.WebSocket;

namespace UniOver.Modules.Devices.Tests.Transport;

/// <summary>
/// O desligamento da API (deploy) com WebSocket de verdade, dos dois lados de um soquete local. O WebSocket do .NET
/// derruba a conexão quando se cancela uma leitura pendente; se a sessão passasse o cancelamento do desligamento
/// direto para a leitura, o agente veria a conexão sumir sem quadro de fechamento, em vez do 1012 que o manda voltar
/// na hora. Nada aqui usa o soquete falso, porque é ele que não reproduz esse comportamento.
/// </summary>
public sealed class WebSocketShutdownCloseTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly DevicesTransportOptions Options = new() { CloseGraceSeconds = 2 };

    [Fact]
    public async Task Receive_WhenTheShutdownIsRequested_ClosesTheAgentWithServiceRestart_InsteadOfAbortingTheSocket()
    {
        var cancellation = TestContext.Current.CancellationToken;
        using var pair = await SocketPair.OpenAsync(cancellation);
        await using var session = new WebSocketAgentSession("pc-casa", pair.Server, Options);
        using var shutdown = new CancellationTokenSource();

        var reading = session.ReceiveAsync(shutdown.Token).AsTask();
        await shutdown.CancelAsync();

        // O agente enxerga o fechamento com o código e o motivo combinados...
        var closing = await pair.ReadUntilCloseAsync(cancellation);
        closing.CloseStatus.Should().Be((WebSocketCloseStatus)1012);
        closing.CloseStatusDescription.Should().Be("service_restart");

        // ... responde como um agente de verdade, e a leitura da sessão termina sem derrubar nada à força.
        await pair.Client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "ok", cancellation);
        var read = await Record.ExceptionAsync(() => reading.WaitAsync(Patience, cancellation));
        read.Should().BeAssignableTo<OperationCanceledException>("quem pediu o desligamento continua sabendo que foi ele");
        pair.Server.State.Should().NotBe(WebSocketState.Aborted);
    }

    [Fact]
    public async Task Receive_WhenTheShutdownIsRequested_AndTheAgentNeverAnswers_StillEndsWithinTheCloseGrace()
    {
        var cancellation = TestContext.Current.CancellationToken;
        using var pair = await SocketPair.OpenAsync(cancellation);
        await using var session = new WebSocketAgentSession("pc-casa", pair.Server, Options);
        using var shutdown = new CancellationTokenSource();

        var reading = session.ReceiveAsync(shutdown.Token).AsTask();
        await shutdown.CancelAsync();

        // O agente não lê nem responde (PC suspenso): a leitura não pode ficar presa para sempre.
        var read = await Record.ExceptionAsync(() => reading.WaitAsync(Patience, cancellation));
        read.Should().BeAssignableTo<OperationCanceledException>();
    }

    [Fact]
    public async Task Receive_WithoutShutdown_StillDeliversTheMessages()
    {
        var cancellation = TestContext.Current.CancellationToken;
        using var pair = await SocketPair.OpenAsync(cancellation);
        await using var session = new WebSocketAgentSession("pc-casa", pair.Server, Options);

        var reading = session.ReceiveAsync(cancellation).AsTask();
        await pair.Client.SendAsync("{}"u8.ToArray(), WebSocketMessageType.Text, true, cancellation);

        (await reading.WaitAsync(Patience, cancellation)).Should().Equal("{}"u8.ToArray());
    }

    /// <summary>Dois WebSockets reais (cliente e servidor) ligados por um soquete TCP local.</summary>
    private sealed class SocketPair : IDisposable
    {
        private readonly NetworkStream _clientStream;
        private readonly NetworkStream _serverStream;

        private SocketPair(WebSocket client, WebSocket server, NetworkStream clientStream, NetworkStream serverStream)
        {
            Client = client;
            Server = server;
            _clientStream = clientStream;
            _serverStream = serverStream;
        }

        public WebSocket Client { get; }

        public WebSocket Server { get; }

        public static async Task<SocketPair> OpenAsync(CancellationToken cancellationToken)
        {
            using var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;

            var clientSocket = new TcpClient();
            var accepting = listener.AcceptTcpClientAsync(cancellationToken).AsTask();
            await clientSocket.ConnectAsync(IPAddress.Loopback, port, cancellationToken);
            var serverSocket = await accepting;

            var clientStream = clientSocket.GetStream();
            var serverStream = serverSocket.GetStream();
            var client = WebSocket.CreateFromStream(clientStream, new WebSocketCreationOptions { IsServer = false });
            var server = WebSocket.CreateFromStream(serverStream, new WebSocketCreationOptions { IsServer = true });
            return new SocketPair(client, server, clientStream, serverStream);
        }

        /// <summary>Lê o que o servidor mandar até o quadro de fechamento; uma conexão que cai sem ele falha o teste.</summary>
        public async Task<WebSocketReceiveResult> ReadUntilCloseAsync(CancellationToken cancellationToken)
        {
            var buffer = new byte[1024];
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Patience);
            while (true)
            {
                var result = await Client.ReceiveAsync(buffer, timeout.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return result;
                }
            }
        }

        public void Dispose()
        {
            Client.Dispose();
            Server.Dispose();
            _clientStream.Dispose();
            _serverStream.Dispose();
        }
    }
}
