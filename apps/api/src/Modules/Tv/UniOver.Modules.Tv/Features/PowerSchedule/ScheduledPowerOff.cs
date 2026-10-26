using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;
using Schedule = UniOver.Modules.Tv.Domain.PowerSchedule;

namespace UniOver.Modules.Tv.Features.PowerSchedule;

internal sealed record SavePowerScheduleRequest(DateTimeOffset DueAtUtc, string? TimeZone, long? Version);
internal sealed record PowerScheduleView(Guid Id, DateTimeOffset DueAtUtc, string TimeZone, string Status, string? Result, string? Reason, long Version);
internal sealed record PowerScheduleResponse(PowerScheduleView? Active, PowerScheduleView? Last);

internal sealed class PowerScheduleHandler(TvDbContext db, ITvCurrentSelection selection, TimeProvider time)
{
    public async Task<PowerScheduleResponse> ReadAsync(CancellationToken ct)
    {
        var tvId = selection.Current.Id;
        var active = await db.PowerSchedules.AsNoTracking().Where(x => x.TvId == tvId
            && (x.Status == Schedule.Pending || x.Status == Schedule.Dispatching)).FirstOrDefaultAsync(ct);
        var last = await db.PowerSchedules.AsNoTracking().Where(x => x.TvId == tvId
            && (x.Status == Schedule.Completed || x.Status == Schedule.Cancelled))
            .OrderByDescending(x => x.UpdatedAt).FirstOrDefaultAsync(ct);
        return new PowerScheduleResponse(
            active is null ? null : View(active), last is null ? null : View(last));
    }

    public async Task<(PowerScheduleView? View, string? Error)> SaveAsync(SavePowerScheduleRequest request, Guid userId, bool isOwner, ClientInfo client, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        if (request.TimeZone is null || request.TimeZone.Length > 100
            || (request.TimeZone != "UTC" && !request.TimeZone.Contains('/'))
            || !TimeZoneInfo.TryFindSystemTimeZoneById(request.TimeZone, out _)
            || request.DueAtUtc.Offset != TimeSpan.Zero || request.DueAtUtc <= now || request.DueAtUtc > now.AddDays(7))
        {
            return (null, "invalid");
        }

        var target = selection.Current;
        if (!target.IsPersisted || string.IsNullOrWhiteSpace(target.AgentSlug)) return (null, "unconfigured");

        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        // Bloqueia a linha da TV para serializar criação e edição e para conferir seu vínculo atual.
        var tv = await db.Tvs.FromSqlInterpolated($"SELECT * FROM tv.tvs WHERE id = {target.Id} FOR UPDATE").SingleOrDefaultAsync(ct);
        if (tv is null || tv.AgentSlug != target.AgentSlug) return (null, "changed");
        var active = await db.PowerSchedules.SingleOrDefaultAsync(x => x.TvId == tv.Id
            && (x.Status == Schedule.Pending || x.Status == Schedule.Dispatching), ct);
        var action = active is null ? "create" : "change";
        if (active is null)
        {
            if (request.Version is not null) return (null, "changed");
            active = Schedule.Create(tv.Id, tv.AgentSlug, userId, isOwner, request.DueAtUtc, request.TimeZone, now);
            db.PowerSchedules.Add(active);
        }
        else
        {
            if (active.Status != Schedule.Pending || request.Version != active.Version) return (null, "changed");
            active.Change(request.DueAtUtc, request.TimeZone, userId, isOwner, now);
        }

        db.CommandAudit.Add(CommandAuditEntry.Create(userId, tv.AgentSlug, TvCommandNames.PowerSchedule,
            action, true, null, null, client, now, tv.Id));
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return (null, "changed");
        }
        await transaction.CommitAsync(ct);
        return (View(active), null);
    }

    public async Task<bool> CancelAsync(long version, Guid userId, ClientInfo client, CancellationToken ct)
    {
        var tvId = selection.Current.Id;
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var active = await db.PowerSchedules.FromSqlInterpolated($"SELECT * FROM tv.power_schedules WHERE tv_id = {tvId} AND status = 'pending' FOR UPDATE")
            .SingleOrDefaultAsync(ct);
        if (active is null || active.Version != version) return false;
        active.Cancel("requested", time.GetUtcNow());
        db.CommandAudit.Add(CommandAuditEntry.Create(userId, active.AgentSlug, TvCommandNames.PowerSchedule,
            "cancel", true, null, null, client, time.GetUtcNow(), tvId));
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return true;
    }

    private static PowerScheduleView View(Schedule x) =>
        new(x.Id, x.DueAtUtc, x.TimeZone, x.Status, x.Result, x.Reason, x.Version);
}

internal static class PowerScheduleEndpoint
{
    public static void MapPowerSchedule(this IEndpointRouteBuilder group)
    {
        group.MapGet("/power/schedule", ReadAsync).RequireAuthorization(TvAuth.Power).Produces<PowerScheduleResponse>();
        group.MapPut("/power/schedule", SaveAsync).RequireAuthorization(TvAuth.Power)
            .RequireRateLimiting(RateLimitPolicies.Commands).Produces<PowerScheduleView>();
        group.MapDelete("/power/schedule", CancelAsync).RequireAuthorization(TvAuth.Power)
            .RequireRateLimiting(RateLimitPolicies.Commands).Produces(StatusCodes.Status204NoContent);
    }

    private static async Task<IResult> ReadAsync(ITvCurrentSelection selection, PowerScheduleHandler handler, CancellationToken ct) =>
        selection.Current.IsPersisted ? TypedResults.Ok(await handler.ReadAsync(ct)) : TypedResults.Ok(new PowerScheduleResponse(null, null));

    private static async Task<IResult> SaveAsync(SavePowerScheduleRequest? request, ICurrentUser current, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, PowerScheduleHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId) return Results.Unauthorized();
        if (request is null) return InvalidRequest();
        var (view, error) = await handler.SaveAsync(request, userId, AccountRoles.Of(principal) == AccountRoles.Owner, TvHttp.ClientOf(http), ct);
        return error switch
        {
            "invalid" => InvalidRequest(),
            "unconfigured" => Results.Problem(statusCode: 503, title: "Configure a TV antes de agendar."),
            "changed" => Results.Problem(statusCode: 409, title: "O agendamento mudou. Atualize a tela."),
            _ => TypedResults.Ok(view),
        };
    }

    private static async Task<IResult> CancelAsync(long version, ICurrentUser current, HttpContext http, PowerScheduleHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId) return TypedResults.Unauthorized();
        return await handler.CancelAsync(version, userId, TvHttp.ClientOf(http), ct)
            ? TypedResults.NoContent()
            : Results.Problem(statusCode: 409, title: "O agendamento mudou. Atualize a tela.");
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult InvalidRequest() => ProblemDetailsExtensions.ValidationProblem(
        new Dictionary<string, string[]> { ["schedule"] = ["Informe um horário UTC futuro (até sete dias) e um fuso IANA válido."] });
}

/// <summary>Reserva no banco antes de enviar; após uma queda, a operação ambígua termina como incerta e nunca é repetida.</summary>
internal sealed class ScheduledPowerOffDispatcher(
    TvDbContext db, TimeProvider time, IAccessGrants grants, TvSelectionService selection,
    IAgentDirectory agents, IAgentPresenceReader presence, ITvCommandSender sender, IOptions<TvModuleOptions> options)
{
    private static readonly TimeSpan Lease = TimeSpan.FromMinutes(2);

    public async Task<int> RunOnceAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        // Uma reserva expirada pode ter enviado POWER antes da queda. Só a classificamos e auditamos; não a reenviamos.
        await using (var recovery = await db.Database.BeginTransactionAsync(ct))
        {
            var expired = await db.PowerSchedules.FromSqlInterpolated($"SELECT * FROM tv.power_schedules WHERE status = 'dispatching' AND lease_until < {now} ORDER BY lease_until LIMIT 1 FOR UPDATE SKIP LOCKED")
                .FirstOrDefaultAsync(ct);
            if (expired is not null)
            {
                expired.Finish("uncertain", now);
                Record(expired, "uncertain", null, null);
                await db.SaveChangesAsync(ct);
                await recovery.CommitAsync(ct);
                return 1;
            }
        }

        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var schedule = await db.PowerSchedules.FromSqlInterpolated($"SELECT * FROM tv.power_schedules WHERE status = 'pending' AND due_at_utc <= {now} ORDER BY due_at_utc LIMIT 1 FOR UPDATE SKIP LOCKED")
            .FirstOrDefaultAsync(ct);
        if (schedule is null) return 0;
        schedule.BeginDispatch(now, Lease);
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);

        string result;
        string? reason = null;
        TvSendOutcome? send = null;
        var tv = await db.Tvs.AsNoTracking().SingleOrDefaultAsync(x => x.Id == schedule.TvId, ct);
        if (tv is null || tv.AgentSlug != schedule.AgentSlug)
        {
            reason = "tv_changed";
            result = "cancelled";
        }
        else if (!await grants.HasAsync(schedule.RequestedBy, AccessPermissions.TvPower, ct)
            || await selection.ResolveAsync(schedule.RequestedBy, schedule.RequestedAsOwner, schedule.TvId, ct) is null)
        {
            reason = "permission_removed";
            result = "cancelled";
        }
        else if (await agents.FindAsync(schedule.AgentSlug, ct) is not { Revoked: false })
        {
            reason = "agent_revoked";
            result = "cancelled";
        }
        else if (presence.Get(schedule.AgentSlug) is not { Connected: true } agent)
        {
            result = "offline";
        }
        else if (!agent.Capabilities.Contains(TvCapabilities.PowerOffV1, StringComparer.Ordinal))
        {
            result = "unsupported";
        }
        else
        {
            // O agente só recebe a operação que lê energia na sessão; a tecla POWER avulsa não entra neste fluxo.
            send = await sender.RequestAsync(schedule.AgentSlug, TvMessages.PowerOff(), options.Value.PowerOffTimeout, ct);
            result = send.Status switch
            {
                TvSendStatus.Delivered => "off",
                TvSendStatus.CommandFailed when send.ErrorCode == TvAgentCodes.AlreadyOff => "already_off",
                TvSendStatus.CommandFailed when send.ErrorCode == TvAgentCodes.Uncertain => "uncertain",
                TvSendStatus.CommandFailed when send.ErrorCode == TvAgentCodes.Offline => "offline",
                TvSendStatus.AgentOffline => "offline",
                TvSendStatus.AgentTimeout => "uncertain",
                _ => "failed",
            };
        }

        if (reason is null) schedule.Finish(result, time.GetUtcNow());
        else schedule.Cancel(reason, time.GetUtcNow());
        Record(schedule, result, reason, send);
        await db.SaveChangesAsync(CancellationToken.None);
        return 1;
    }

    private void Record(Schedule schedule, string result, string? reason, TvSendOutcome? send) =>
        db.CommandAudit.Add(CommandAuditEntry.Create(schedule.RequestedBy, schedule.AgentSlug,
            TvCommandNames.PowerOff, "scheduled", result is "off" or "already_off", reason ?? (result == "off" ? null : result),
            send is null ? null : (int)send.Latency.TotalMilliseconds, new ClientInfo(null, null), time.GetUtcNow(), schedule.TvId));

}

internal sealed partial class ScheduledPowerOffWorker(IServiceScopeFactory scopes, TimeProvider time, ILogger<ScheduledPowerOffWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15), time);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var dispatcher = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>();
                while (await dispatcher.RunOnceAsync(stoppingToken) != 0) { }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { LogFailure(logger, ex.GetType().Name); }
            if (!await timer.WaitForNextTickAsync(stoppingToken)) break;
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao processar desligamentos agendados ({Error}).")]
    private static partial void LogFailure(ILogger logger, string error);
}
