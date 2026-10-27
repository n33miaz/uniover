using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Identity.Contracts;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.Outages;

/// <summary>
/// Vigia a presença dos agentes: o computador que fica sem sinal por mais que <c>devices.agent-offline-minutes</c> abre
/// UMA queda (e uma linha de auditoria), e a volta a fecha (e registra de novo). Quem está conectado agora nunca conta como
/// caído; quem não está vale pelo último sinal persistido, mas nunca antes do início deste processo: depois de um deploy ou
/// de o serviço acordar, o retrato ainda é de quando a API dormia, e o computador precisa de tempo para reconectar.
/// </summary>
internal sealed class AgentOutageMonitor(
    DevicesDbContext db,
    IAgentPresenceReader presence,
    ISystemSettings settings,
    PublishedBuild build,
    TimeProvider time)
{
    public async Task CheckAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var limit = TimeSpan.FromMinutes(await settings.AgentOfflineMinutesAsync(cancellationToken));

        var agents = await db.Agents.AsNoTracking()
            .Select(a => new { a.Id, a.Slug, Revoked = a.RevokedAt != null })
            .ToListAsync(cancellationToken);
        var snapshots = await db.AgentPresenceSnapshots.AsNoTracking()
            .Where(s => s.LastSeenAt != null)
            .ToDictionaryAsync(s => s.AgentId, s => s.LastSeenAt, cancellationToken);
        var open = await db.AgentOutages.Where(o => o.RecoveredAt == null).ToDictionaryAsync(o => o.AgentId, cancellationToken);

        foreach (var agent in agents)
        {
            open.TryGetValue(agent.Id, out var outage);
            if (agent.Revoked)
            {
                // Revogado não "volta": a queda só é encerrada, sem aviso de volta.
                outage?.Recover(now);
                continue;
            }

            var live = presence.Get(agent.Slug);
            if (live is { Connected: true })
            {
                if (outage?.Recover(now) == true)
                {
                    Audit(PairingEvents.AgentOnline, agent.Id, now);
                }

                continue;
            }

            if (outage is not null)
            {
                continue;
            }

            var lastSeen = Latest(snapshots.GetValueOrDefault(agent.Id), live?.DisconnectedAt, live?.LastMessageAt);
            if (lastSeen is null)
            {
                // Nunca falou: não há queda de quem ainda não ficou de pé.
                continue;
            }

            var since = lastSeen.Value > build.StartedAt ? lastSeen.Value : build.StartedAt;
            if (now - since > limit)
            {
                db.AgentOutages.Add(AgentOutage.Open(IdGenerator.NewId(), agent.Id, now, lastSeen));
                Audit(PairingEvents.AgentOffline, agent.Id, now);
            }
        }

        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException) when (db.ChangeTracker.Entries<AgentOutage>().Any(e => e.State == EntityState.Added))
        {
            // Outra instância abriu a mesma queda no mesmo instante (índice único): o aviso já existe, e o próximo ciclo reconcilia.
            db.ChangeTracker.Clear();
        }
    }

    private static DateTimeOffset? Latest(params DateTimeOffset?[] instants) => instants.Max();

    private void Audit(string eventName, Guid agentId, DateTimeOffset now) =>
        db.PairingAudit.Add(PairingAuditEntry.Create(eventName, agentId, null, null, null, null, now));
}

internal sealed partial class AgentOutageWorker(IServiceScopeFactory scopes, TimeProvider time, ILogger<AgentOutageWorker> logger)
    : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval, time);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<AgentOutageMonitor>().CheckAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                LogFailure(logger, ex.GetType().Name);
            }

            if (!await timer.WaitForNextTickAsync(stoppingToken))
            {
                break;
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao vigiar a presença dos agentes ({Error}).")]
    private static partial void LogFailure(ILogger logger, string error);
}

/// <summary>
/// Um aviso de queda como o dono o vê: só nome do computador e horários. <c>RecoveredAt</c> preenchido = o computador voltou.
/// </summary>
internal sealed record AgentAlert(
    Guid Id, Guid AgentId, string AgentName, DateTimeOffset DetectedAt, DateTimeOffset? LastSeenAt, DateTimeOffset? RecoveredAt);

internal sealed class AgentAlertsHandler(DevicesDbContext db, TimeProvider time)
{
    /// <summary>Quanto tempo um aviso de "voltou" ainda aparece se ninguém o viu.</summary>
    public static readonly TimeSpan RecoveredWindow = TimeSpan.FromHours(24);

    public async Task<IReadOnlyList<AgentAlert>> ListAsync(CancellationToken cancellationToken)
    {
        var floor = time.GetUtcNow() - RecoveredWindow;
        var rows = await (from o in db.AgentOutages.AsNoTracking()
                          join a in db.Agents.AsNoTracking() on o.AgentId equals a.Id
                          where a.RevokedAt == null && o.SeenAt == null && (o.RecoveredAt == null || o.RecoveredAt > floor)
                          orderby o.DetectedAt descending
                          select new { o.Id, o.AgentId, a.Name, o.DetectedAt, o.LastSeenAt, o.RecoveredAt })
            .ToListAsync(cancellationToken);
        return [.. rows.Select(r => new AgentAlert(r.Id, r.AgentId, r.Name, r.DetectedAt, r.LastSeenAt, r.RecoveredAt))];
    }

    /// <summary>O dono viu: os avisos abertos ou recém-voltados saem da Início e de Dispositivos.</summary>
    public async Task MarkSeenAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        await db.AgentOutages.Where(o => o.SeenAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(o => o.SeenAt, now), cancellationToken);
    }
}

internal static class AgentAlertsEndpoint
{
    public static void MapAgentAlerts(this IEndpointRouteBuilder group)
    {
        group.MapGet("/agent-alerts", async (AgentAlertsHandler handler, CancellationToken cancellationToken) =>
                TypedResults.Ok(await handler.ListAsync(cancellationToken)))
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<IReadOnlyList<AgentAlert>>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

        group.MapPost("/agent-alerts/seen", async (AgentAlertsHandler handler, CancellationToken cancellationToken) =>
            {
                await handler.MarkSeenAsync(cancellationToken);
                return TypedResults.NoContent();
            })
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
    }
}
