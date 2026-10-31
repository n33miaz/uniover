using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using UniOver.Modules.Devices.Ports;
using UniOver.SharedKernel.Diagnostics;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>
/// Liga os transportes registrados ao núcleo: cada sessão que um transporte entrega vira uma tarefa do
/// <see cref="AgentHub"/>. Ao parar a aplicação o cancelamento chega ao hub, que fecha as sessões com o motivo
/// de desligamento; o serviço só termina quando todas terminaram, para o desligamento não deixar conexão solta.
/// </summary>
internal sealed partial class AgentTransportListener(
    IEnumerable<IAgentTransport> transports,
    AgentHub hub,
    ILogger<AgentTransportListener> logger) : BackgroundService
{
    private readonly ConcurrentDictionary<Task, byte> _sessions = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var pumps = transports.Select(t => PumpAsync(t, stoppingToken)).ToArray();
        try
        {
            await Task.WhenAll(pumps);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Desligamento normal.
        }
        finally
        {
            await Task.WhenAll(_sessions.Keys);
        }
    }

    private async Task PumpAsync(IAgentTransport transport, CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var session in transport.AcceptSessionsAsync(stoppingToken))
            {
                var task = RunSessionAsync(session, stoppingToken);
                _sessions.TryAdd(task, 0);
                _ = task.ContinueWith(t => _sessions.TryRemove(t, out _), TaskScheduler.Default);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Desligamento normal.
        }
        catch (Exception ex)
        {
            LogTransportFailed(transport.Name, ex.GetType().Name);
        }
    }

    private async Task RunSessionAsync(IAgentSession session, CancellationToken stoppingToken)
    {
        try
        {
            await hub.RunSessionAsync(session, stoppingToken);
        }
        catch (Exception ex)
        {
            LogSessionFailed(session.AgentId, ErrorDetail.Stack(ex));
        }
    }

    // Só o tipo do erro: a mensagem de uma falha de rede ou de banco pode citar servidor e conexão.
    [LoggerMessage(Level = LogLevel.Error, Message = "O transporte {Transport} falhou e não aceita mais conexões ({ErrorType}).")]
    private partial void LogTransportFailed(string transport, string errorType);

    [LoggerMessage(Level = LogLevel.Error, Message = "Sessão do agente {AgentId} terminou com erro ({Error}).")]
    private partial void LogSessionFailed(string agentId, string error);
}
