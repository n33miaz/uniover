using System.Net.WebSockets;
using System.Security.Claims;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Ports;

namespace UniOver.Modules.Devices.Transport.WebSocket;

/// <summary>
/// O adaptador WebSocket da porta <see cref="IAgentTransport"/>. A requisição HTTP já chegou autenticada pelo
/// token de dispositivo (política declarada pelo módulo); aqui só se faz o <i>upgrade</i>, entrega a sessão ao
/// núcleo e mantém a requisição aberta enquanto a sessão viver.
/// </summary>
internal sealed class WebSocketAgentTransport(
    IOptions<DevicesTransportOptions> options,
    IHostApplicationLifetime lifetime) : IAgentTransport
{
    private readonly Channel<IAgentSession> _sessions = Channel.CreateUnbounded<IAgentSession>();

    public string Name => "websocket";

    public IAsyncEnumerable<IAgentSession> AcceptSessionsAsync(CancellationToken cancellationToken) =>
        _sessions.Reader.ReadAllAsync(cancellationToken);

    public async Task HandleAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        var slug = context.User.FindFirstValue(DeviceAuth.SlugClaim);
        if (slug is null)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        var settings = options.Value;
        using var socket = await context.WebSockets.AcceptWebSocketAsync(new WebSocketAcceptContext
        {
            KeepAliveInterval = settings.KeepAlive,
            DangerousEnableCompression = false,
        });

        var session = new WebSocketAgentSession(slug, socket, settings);
        if (!_sessions.Writer.TryWrite(session))
        {
            return;
        }

        // A requisição dura o que a sessão durar; o desligamento da aplicação também a encerra. Quem descarta a
        // sessão (e fecha o socket) é o núcleo, ao terminar a condução dela.
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            context.RequestAborted, lifetime.ApplicationStopping);
        try
        {
            await session.Completion.WaitAsync(linked.Token);
        }
        catch (OperationCanceledException)
        {
            await session.CloseAsync(AgentCloseReason.Shutdown, CancellationToken.None);
        }
    }
}
