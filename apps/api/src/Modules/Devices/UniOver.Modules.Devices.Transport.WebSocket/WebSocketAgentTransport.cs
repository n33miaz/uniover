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

    /// <summary>
    /// Atende o upgrade. <paramref name="handoverCandidate"/> é a rota própria da versão nova do agente na passagem sem queda: a
    /// sessão fica fora do roteamento até o <c>hello</c> de passagem. É rota, e não cabeçalho, para uma API que ainda não conhece a
    /// passagem (a instância anterior, num deploy em andamento) responder 404 em vez de tratar a candidata como conexão comum e
    /// substituir a que serve.
    /// </summary>
    public async Task HandleAsync(HttpContext context, bool handoverCandidate = false)
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

        var session = new WebSocketAgentSession(slug, socket, settings, handoverCandidate);
        if (!_sessions.Writer.TryWrite(session))
        {
            return;
        }

        // A requisição dura o que a sessão durar. Quem descarta a sessão (e fecha o socket) é o núcleo, ao terminar a condução
        // dela; o desligamento da aplicação NÃO fecha nada aqui: o hub decide entre o 4411 (agente que o entende, depois de
        // drenar os comandos em curso) e o 1012, e um fechamento antecipado do endpoint tiraria o 4411 do agente.
        using var done = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        var fallback = CloseIfNobodyDoesAfterStoppingAsync(session, done.Token);
        try
        {
            await session.Completion.WaitAsync(context.RequestAborted);
        }
        catch (OperationCanceledException)
        {
            await session.CloseAsync(AgentCloseReason.Shutdown, CancellationToken.None);
        }
        finally
        {
            await done.CancelAsync();
            await fallback;
        }
    }

    /// <summary>
    /// Rede de segurança: depois do aviso de parada e do prazo que o hub tem para drenar e fechar, uma sessão que ninguém conduz
    /// (entregue ao transporte e nunca lida, porque o serviço parou) é fechada aqui com o 1012, para a requisição não ficar
    /// pendurada até o host derrubá-la.
    /// </summary>
    private async Task CloseIfNobodyDoesAfterStoppingAsync(WebSocketAgentSession session, CancellationToken done)
    {
        var settings = options.Value;
        var stopping = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var registration = lifetime.ApplicationStopping.Register(() => stopping.TrySetResult());
        try
        {
            await stopping.Task.WaitAsync(done);
            await Task.Delay(settings.DrainWait + (settings.CloseGrace * 3) + TimeSpan.FromSeconds(1), done);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        await session.CloseAsync(AgentCloseReason.Shutdown, CancellationToken.None);
    }
}
