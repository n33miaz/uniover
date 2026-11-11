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
using UniOver.SharedKernel;
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

/// <summary>
/// Avisa o laço dos desligamentos agendados que o trabalho mudou (criou, mudou ou cancelou um pedido): ele dorme até o
/// próximo instante útil e, sem este aviso, só notaria a mudança na varredura de reserva. Em processo; outra instância
/// notaria só pela reserva (e, na partida, pela varredura que toda instância nova faz).
/// </summary>
internal sealed class PowerScheduleSignal
{
    public WakeSignal Wake { get; } = new();

    public void Notify() => Wake.Notify();
}

internal sealed class PowerScheduleHandler(TvDbContext db, ITvCurrentSelection selection, TimeProvider time, PowerScheduleSignal signal)
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
        // Só depois do commit: avisar antes faria o laço olhar uma linha ainda invisível e voltar a dormir.
        signal.Notify();
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
        signal.Notify();
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

/// <summary>O que o laço dos desligamentos agendados precisa da fila: uma rodada de trabalho e o próximo instante em que há o que fazer.</summary>
internal interface IPowerOffQueue
{
    /// <summary>Processa um pedido devido (ou recupera uma reserva vencida). Devolve 0 se não havia nada a fazer agora.</summary>
    Task<int> RunOnceAsync(CancellationToken ct);

    /// <summary>
    /// O instante em que a fila volta a ter trabalho: o menor entre a hora combinada dos pedidos pendentes (ou o fim da espera de
    /// uma nova tentativa, se for depois) e o fim da reserva dos que estão sendo enviados. Nulo se não há pedido em aberto.
    /// </summary>
    Task<DateTimeOffset?> NextWakeAsync(CancellationToken ct);
}

/// <summary>Reserva no banco antes de enviar; após uma queda, a operação ambígua termina como incerta e nunca é repetida.</summary>
internal sealed class ScheduledPowerOffDispatcher(
    TvDbContext db, TimeProvider time, IAccessGrants grants, TvSelectionService selection,
    IAgentDirectory agents, IAgentPresenceReader presence, ITvCommandSender sender, IOptions<TvModuleOptions> options) : IPowerOffQueue
{
    private static readonly TimeSpan Lease = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Quanto depois da hora combinada ainda vale enviar o desligamento. Passado esse prazo (a API estava fora do ar, o banco
    /// dormia) a TV pode estar sendo usada: o agendamento termina como <c>missed</c>, com auditoria, e nada é enviado.
    /// </summary>
    internal static readonly TimeSpan MaxLateness = TimeSpan.FromMinutes(10);

    /// <summary>Quanto o pedido espera antes de ser tentado de novo quando o agente ainda não está pronto (sem sessão ou sem hello).</summary>
    internal static readonly TimeSpan NotReadyRetryAfter = TimeSpan.FromSeconds(15);

    public async Task<DateTimeOffset?> NextWakeAsync(CancellationToken ct) =>
        // Pendente: vale a hora combinada, ou o fim da espera da nova tentativa quando este é depois (a mesma regra de
        // RunOnceAsync: due_at_utc <= agora E lease_until nulo ou <= agora). Enviando: o fim da reserva (a recuperação só age
        // depois dele). Os outros estados não têm trabalho.
        await db.PowerSchedules.AsNoTracking()
            .Where(x => x.Status == Schedule.Pending || x.Status == Schedule.Dispatching)
            .Select(x => x.Status == Schedule.Dispatching
                ? x.LeaseUntil
                : (x.LeaseUntil != null && x.LeaseUntil > x.DueAtUtc ? x.LeaseUntil : (DateTimeOffset?)x.DueAtUtc))
            .MinAsync(ct);

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
        var schedule = await db.PowerSchedules.FromSqlInterpolated($"SELECT * FROM tv.power_schedules WHERE status = 'pending' AND due_at_utc <= {now} AND (lease_until IS NULL OR lease_until <= {now}) ORDER BY due_at_utc LIMIT 1 FOR UPDATE SKIP LOCKED")
            .FirstOrDefaultAsync(ct);
        if (schedule is null) return 0;
        schedule.BeginDispatch(now, Lease);
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);

        string result;
        string? reason = null;
        TvSendOutcome? send = null;
        var tv = await db.Tvs.AsNoTracking().SingleOrDefaultAsync(x => x.Id == schedule.TvId, ct);
        if (now - schedule.DueAtUtc > MaxLateness)
        {
            result = "missed";
        }
        else if (tv is null || tv.AgentSlug != schedule.AgentSlug)
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
        else if (presence.Get(schedule.AgentSlug) is not { Connected: true, Capabilities.Count: > 0 } agent)
        {
            // Sem sessão (um deploy no minuto combinado, uma queda de poucos segundos) ou conectado sem o hello (a API
            // acabou de subir): não se sabe se o agente está ali nem se há o desligar seguro. Nada é enviado nem encerrado;
            // o pedido volta à fila e é tentado de novo daqui a pouco, até o teto de atraso (aí fecha como `missed`).
            // Devolve 1 (houve trabalho) para a rodada seguir com os pedidos das outras TVs.
            schedule.ReleaseDispatch(time.GetUtcNow(), NotReadyRetryAfter);
            await db.SaveChangesAsync(CancellationToken.None);
            return 1;
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

/// <summary>
/// Entrega os desligamentos agendados sem tique fixo: o Neon gratuito dorme depois de 5 min sem consulta e o plano tem um teto
/// mensal de horas acordado, então um laço de segundos manteria o banco ligado o mês inteiro sem ninguém usar. Cada rodada
/// esvazia o que está devido e pergunta ao banco o próximo instante útil (<see cref="IPowerOffQueue.NextWakeAsync"/>); o prazo da
/// próxima rodada fica em memória, como instante do relógio de parede, e o laço dorme em passos de no máximo
/// <see cref="MaxSleep"/>, reconferindo o relógio a cada passo SEM consultar o banco: um ajuste do relógio (NTP, VM retomada) é
/// notado em até um minuto, em vez de a espera longa ser contada uma vez só. Só ao chegar a hora (ou ao ser acordado por
/// <see cref="PowerScheduleSignal"/>: criou, mudou, cancelou) é que consulta. Sem pedido em aberto o prazo é o tempo de reserva
/// (<c>PowerOffReserveMinutes</c>), que cobre o pedido criado por outra instância. Nos primeiros minutos da vida do processo o
/// prazo é curto (<c>PowerOffStartupPollSeconds</c>): numa troca de instância a antiga ainda atende e pode receber um pedido
/// que esta não viu, e o banco está acordado de qualquer forma. A primeira rodada é na própria partida, então um pedido que
/// ficou pendente (a instância que o recebeu parou sem avisar ninguém) é encontrado por quem sobe.
/// </summary>
internal sealed partial class ScheduledPowerOffWorker(
    IServiceScopeFactory scopes, TimeProvider time, PowerScheduleSignal signal, IOptions<TvModuleOptions> options,
    ILogger<ScheduledPowerOffWorker> logger) : BackgroundService
{
    /// <summary>Folga mínima quando o instante já passou e nada foi tomado (outra instância segura a linha): evita laço apertado.</summary>
    internal static readonly TimeSpan MinimumWait = TimeSpan.FromSeconds(1);

    /// <summary>O maior sono seguido: depois dele o prazo (em memória) é recalculado pelo relógio, sem tocar no banco.</summary>
    internal static readonly TimeSpan MaxSleep = TimeSpan.FromMinutes(1);

    private static readonly TimeSpan FailureWait = TimeSpan.FromSeconds(15);

    /// <summary>Teto da espera depois de falhas seguidas: muito abaixo de <see cref="ScheduledPowerOffDispatcher.MaxLateness"/>.</summary>
    private static readonly TimeSpan MaxFailureWait = TimeSpan.FromMinutes(2);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var startedAt = time.GetUtcNow();
        var failures = 0;
        var sweepAt = startedAt; // a primeira rodada é na partida
        var signaled = false;
        while (!stoppingToken.IsCancellationRequested)
        {
            if (signaled || time.GetUtcNow() >= sweepAt)
            {
                signaled = false;
                DateTimeOffset? next = null;
                try
                {
                    await using var scope = scopes.CreateAsyncScope();
                    var queue = scope.ServiceProvider.GetRequiredService<IPowerOffQueue>();
                    while (await queue.RunOnceAsync(stoppingToken) != 0) { }
                    next = await queue.NextWakeAsync(stoppingToken);
                    failures = 0;
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception ex)
                {
                    failures++;
                    LogFailure(logger, ex.GetType().Name);
                }

                var now = time.GetUtcNow();
                sweepAt = now + (failures > 0 ? FailureDelay(failures) : WaitFor(next, now, startedAt));
            }

            var sleep = sweepAt - time.GetUtcNow();
            try
            {
                signaled = await signal.Wake.WaitAsync(sleep < MaxSleep ? sleep : MaxSleep, time, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }

    /// <summary>Quanto falta para a próxima consulta: até o próximo instante útil, nunca além da reserva (ou da espera curta dos primeiros minutos).</summary>
    internal TimeSpan WaitFor(DateTimeOffset? next, DateTimeOffset now, DateTimeOffset startedAt)
    {
        var settings = options.Value;
        var cap = now - startedAt < settings.PowerOffStartupWindow ? settings.PowerOffStartupPoll : settings.PowerOffReserve;
        if (next is null)
        {
            return cap;
        }

        var until = next.Value - now;
        if (until <= TimeSpan.Zero)
        {
            until = MinimumWait;
        }

        return until < cap ? until : cap;
    }

    private static TimeSpan FailureDelay(int failures)
    {
        var delay = TimeSpan.FromSeconds(FailureWait.TotalSeconds * Math.Pow(2, Math.Min(failures - 1, 6)));
        return delay < MaxFailureWait ? delay : MaxFailureWait;
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao processar desligamentos agendados ({Error}).")]
    private static partial void LogFailure(ILogger logger, string error);
}
