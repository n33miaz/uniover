using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.Presence;

/// <summary>
/// Depois de um deploy a API nova sobe com a presença vazia. Quem foi visto há menos que a graça de presença, pelo
/// resumo que a instância anterior gravou, passa a contar como conectado até esse prazo acabar; se o agente reconecta aqui a presença real
/// assume, e se não volta o resumo deixa de renovar e ele sai sozinho. Nos primeiros minutos a leitura se repete, porque
/// durante a troca a instância antiga ainda atende e continua renovando o resumo.
/// </summary>
internal sealed partial class AgentPresenceSeeder(
    IServiceScopeFactory scopes,
    AgentConnections connections,
    IOptions<DevicesTransportOptions> options,
    TimeProvider time,
    ILogger<AgentPresenceSeeder> logger) : BackgroundService
{
    /// <summary>Intervalo entre leituras do resumo nos primeiros minutos de vida do processo.</summary>
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);

    /// <summary>Depois disto não há mais instância anterior atendendo: só a presença real vale.</summary>
    public static readonly TimeSpan OverlapWindow = TimeSpan.FromMinutes(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (options.Value.PresenceGrace <= TimeSpan.Zero)
        {
            return;
        }

        var startedAt = time.GetUtcNow();
        using var timer = new PeriodicTimer(PollInterval, time);
        try
        {
            // A primeira leitura começa junto com a partida, antes de a primeira tela chegar.
            await SeedQuietlyAsync(stoppingToken);
            while (time.GetUtcNow() - startedAt < OverlapWindow && await timer.WaitForNextTickAsync(stoppingToken))
            {
                await SeedQuietlyAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Desligamento normal.
        }
    }

    /// <summary>Uma leitura do resumo; falha do banco só é registrada, porque a presença real não depende dela.</summary>
    public async Task SeedAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var floor = now - options.Value.PresenceGrace;
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<DevicesDbContext>();
        var seen = await (from snapshot in db.AgentPresenceSnapshots.AsNoTracking()
                          join agent in db.Agents.AsNoTracking() on snapshot.AgentId equals agent.Id
                          where agent.RevokedAt == null && snapshot.LastSeenAt != null
                          select new { agent.Slug, LastSeenAt = snapshot.LastSeenAt!.Value, snapshot.AgentVersion })
            .ToListAsync(cancellationToken);
        foreach (var agent in seen)
        {
            if (agent.LastSeenAt > floor)
            {
                connections.ExpectReturn(agent.Slug, agent.LastSeenAt, agent.AgentVersion);
            }
            else
            {
                // Já estava fora antes desta API subir: só lembra desde quando, para a tela dizer "desligado desde...".
                connections.NoteLastSeen(agent.Slug, agent.LastSeenAt, agent.AgentVersion);
            }
        }
    }

    private async Task SeedQuietlyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await SeedAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
#pragma warning disable CA1031 // A leitura é um adiantamento: sem ela a presença só espera cada agente reconectar.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogSeedFailed(logger, ex.GetType().Name);
        }
    }

    // Só o tipo do erro: a mensagem do driver do banco pode citar o servidor e a conexão.
    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível ler o último sinal dos agentes ao subir ({ErrorType}).")]
    private static partial void LogSeedFailed(ILogger logger, string errorType);
}
