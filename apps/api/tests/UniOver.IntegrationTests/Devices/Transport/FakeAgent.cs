using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.TestHost;

namespace UniOver.IntegrationTests.Devices.Transport;

/// <summary>Como o servidor encerrou a conexão do agente falso.</summary>
internal sealed record CloseInfo(WebSocketCloseStatus? Status, string? Description);

/// <summary>
/// Agente falso reutilizável: abre o WebSocket do servidor de teste com o token de dispositivo no cabeçalho, manda e
/// lê mensagens do contrato. Responde ao fechamento do servidor como um agente de verdade (sem isso o aperto de
/// mão de fechamento ficaria pendurado). Todo <c>await</c> tem prazo em tempo real, para um teste que esquece de
/// avançar o relógio falso falhar rápido em vez de travar.
/// </summary>
internal sealed class FakeAgent : IAsyncDisposable
{
    public static readonly TimeSpan Patience = TimeSpan.FromSeconds(15);

    private readonly WebSocket _socket;

    private FakeAgent(string slug, WebSocket socket)
    {
        Slug = slug;
        _socket = socket;
    }

    public string Slug { get; }

    public WebSocketState State => _socket.State;

    /// <summary>Código e motivo do fechamento pelo servidor, quando já ocorreu.</summary>
    public CloseInfo? Closed { get; private set; }

    public static async Task<FakeAgent> ConnectAsync(TestServer server, string slug, string token)
    {
        ArgumentNullException.ThrowIfNull(server);

        var client = server.CreateWebSocketClient();
        client.ConfigureRequest = request => request.Headers.Authorization = $"Bearer {token}";
        using var timeout = new CancellationTokenSource(Patience);
        var socket = await client.ConnectAsync(new Uri($"wss://localhost/api/v1/devices/agents/{slug}/ws"), timeout.Token);
        return new FakeAgent(slug, socket);
    }

    /// <summary>Monta um envelope do contrato como o agente o escreveria.</summary>
    public static string Envelope(
        string type, string source, JsonNode body, Guid? correlationId = null, string target = "api", Guid? id = null, int version = 1) =>
        new JsonObject
        {
            ["v"] = version,
            ["id"] = (id ?? Guid.CreateVersion7()).ToString(),
            ["type"] = type,
            ["source"] = source,
            ["target"] = target,
            ["ts"] = "2026-10-19T12:00:00Z",
            ["correlationId"] = correlationId?.ToString(),
            ["body"] = body.DeepClone(),
        }.ToJsonString();

    public string Envelope(string type, JsonNode body, Guid? correlationId = null) =>
        Envelope(type, $"agent:{Slug}", body, correlationId);

    public Task SendHelloAsync(string version = "1.2.3", params string[] capabilities) =>
        SendTextAsync(Envelope(
            "agent.hello.v1",
            new JsonObject { ["agentVersion"] = version, ["capabilities"] = new JsonArray([.. capabilities.Select(c => (JsonNode)JsonValue.Create(c)!)]) }));

    public async Task SendTextAsync(string text)
    {
        using var timeout = new CancellationTokenSource(Patience);
        await _socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, timeout.Token);
    }

    public async Task SendBinaryAsync(byte[] data)
    {
        using var timeout = new CancellationTokenSource(Patience);
        await _socket.SendAsync(data, WebSocketMessageType.Binary, true, timeout.Token);
    }

    /// <summary>Próxima mensagem de texto do servidor; nulo se o servidor fechou (o fechamento fica em <see cref="Closed"/>).</summary>
    public async Task<JsonElement?> ReceiveAsync()
    {
        using var timeout = new CancellationTokenSource(Patience);
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await _socket.ReceiveAsync(buffer, timeout.Token);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                Closed = new CloseInfo(result.CloseStatus, result.CloseStatusDescription);
                if (_socket.State == WebSocketState.CloseReceived)
                {
                    await _socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "ok", timeout.Token);
                }

                return null;
            }

            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                return JsonSerializer.Deserialize<JsonElement>(message.ToArray());
            }
        }
    }

    /// <summary>Lê até o servidor fechar e devolve como fechou.</summary>
    public async Task<CloseInfo> WaitForCloseAsync()
    {
        while (await ReceiveAsync() is not null)
        {
            // Descarta o que ainda chegar antes do fechamento.
        }

        return Closed!;
    }

    public async ValueTask DisposeAsync()
    {
        if (_socket.State == WebSocketState.Open)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", timeout.Token);
            }
            catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
            {
                // Já caiu.
            }
        }

        _socket.Dispose();
    }
}
