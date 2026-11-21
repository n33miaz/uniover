using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// As contagens de desligar ou reiniciar que o agente aceitou há pouco, pelo identificador opaco de cada uma (o <c>id</c> do comando
/// <c>pc.power</c> que a agendou): quem pediu, de onde, e qual é a mais recente de cada agente. O agente só avisa o desfecho depois
/// (<c>pc.power.outcome.v1</c>, com o mesmo identificador), já sem o pedido HTTP: a pessoa da linha de auditoria sai daqui, e só da
/// contagem certa (um desfecho atrasado de outra contagem nunca leva a pessoa errada). Cada desfecho é gravado uma vez. Em memória e da
/// instância: com a API reiniciada, a falha ainda é gravada, só sem a pessoa.
/// </summary>
internal sealed class PcPowerCountdowns(TimeProvider time)
{
    /// <summary>Bem mais que a contagem mais longa do agente (e que os 5 min em que o app oferece cancelar).</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);

    private readonly object _gate = new();
    private readonly Dictionary<Guid, PcPowerCountdown> _countdowns = [];
    private readonly Dictionary<string, Guid> _latest = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, DateTimeOffset> _recorded = [];

    public void Scheduled(string agentSlug, Guid countdownId, PcPowerCountdown countdown)
    {
        lock (_gate)
        {
            Prune();
            _countdowns[countdownId] = countdown with { Slug = agentSlug, At = time.GetUtcNow() };
            _latest[agentSlug] = countdownId;
        }
    }

    /// <summary>
    /// O app cancelou a contagem <paramref name="countdownId"/> (sem ele, a mais recente do agente): a lembrança dela sai. A contagem de outro
    /// agente nunca sai por aqui.
    /// </summary>
    public void Cancelled(string agentSlug, Guid? countdownId = null)
    {
        lock (_gate)
        {
            Guid? id = countdownId ?? (_latest.TryGetValue(agentSlug, out var latest) ? latest : null);
            if (id is { } known && _countdowns.TryGetValue(known, out var countdown)
                && string.Equals(countdown.Slug, agentSlug, StringComparison.Ordinal))
            {
                _countdowns.Remove(known);
            }
        }
    }

    /// <summary>A contagem é a mais recente do agente, ou a instância não conhece nenhuma (reiniciada): o app deve saber do desfecho.</summary>
    public bool IsCurrent(string agentSlug, Guid countdownId)
    {
        lock (_gate)
        {
            return !_latest.TryGetValue(agentSlug, out var latest) || latest == countdownId;
        }
    }

    /// <summary>Marca o desfecho da contagem como gravado; <c>false</c> se ele já tinha sido (o agente reenviou).</summary>
    public bool TryRecord(Guid countdownId)
    {
        lock (_gate)
        {
            Prune();
            return _recorded.TryAdd(countdownId, time.GetUtcNow());
        }
    }

    /// <summary>A contagem <paramref name="countdownId"/> daquele agente, se ainda vale; sai daqui.</summary>
    public PcPowerCountdown? Take(string agentSlug, Guid countdownId)
    {
        lock (_gate)
        {
            if (!_countdowns.TryGetValue(countdownId, out var countdown) || !string.Equals(countdown.Slug, agentSlug, StringComparison.Ordinal))
            {
                return null;
            }

            _countdowns.Remove(countdownId);
            return time.GetUtcNow() - countdown.At <= Lifetime ? countdown : null;
        }
    }

    private void Prune()
    {
        var now = time.GetUtcNow();
        foreach (var id in _countdowns.Where(c => now - c.Value.At > Lifetime).Select(c => c.Key).ToList())
        {
            _countdowns.Remove(id);
        }

        foreach (var id in _recorded.Where(r => now - r.Value > Lifetime).Select(r => r.Key).ToList())
        {
            _recorded.Remove(id);
        }
    }
}

/// <summary>
/// O último desfecho de contagem que cada agente avisou, para <c>GET /pc/status</c> (<c>power</c>): o app para de oferecer "cancelar" e
/// diz o que houve. Em memória e da instância, vale por <see cref="Lifetime"/> desde que chegou (depois disso o app já escondeu o botão
/// sozinho). Uma contagem nova o apaga: o desfecho era da anterior.
/// </summary>
internal sealed class PcPowerNotices(TimeProvider time)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    private readonly object _gate = new();
    private readonly Dictionary<string, (PcPowerNotice Notice, DateTimeOffset Received)> _notices = new(StringComparer.Ordinal);

    public void Set(string agentSlug, PcPowerNotice notice)
    {
        lock (_gate)
        {
            _notices[agentSlug] = (notice, time.GetUtcNow());
        }
    }

    public void Forget(string agentSlug)
    {
        lock (_gate)
        {
            _notices.Remove(agentSlug);
        }
    }

    public PcPowerNotice? Get(string agentSlug)
    {
        lock (_gate)
        {
            return _notices.TryGetValue(agentSlug, out var entry) && time.GetUtcNow() - entry.Received <= Lifetime ? entry.Notice : null;
        }
    }
}

/// <summary>
/// O desfecho de uma contagem que não terminou no pedido: <c>CountdownId</c> (o identificador opaco dela), <c>Action</c> (<c>SHUTDOWN</c>
/// ou <c>RESTART</c>), <c>Outcome</c> (<c>refused</c>: o Windows recusou; <c>lost</c>: o agente reiniciou no meio; <c>cancelled</c>: quem
/// está no PC cancelou no aviso) e <c>At</c>, quando aconteceu (relógio do agente).
/// </summary>
internal sealed record PcPowerNotice(Guid CountdownId, string Action, string Outcome, DateTimeOffset At);

/// <summary>Uma contagem aceita pelo agente: o agente (Guid), quem pediu, de onde, e a ação (<c>SHUTDOWN</c> ou <c>RESTART</c>).</summary>
internal sealed record PcPowerCountdown(
    Guid AgentId, Guid UserId, ClientInfo Client, string Action, string Slug = "", DateTimeOffset At = default);

/// <summary>
/// O desfecho que o agente avisou (<c>pc.power.outcome.v1</c>): a contagem não terminou no pedido. Recusada ou perdida vira a linha de
/// falha da ação, com quem pediu quando a instância ainda lembra daquela contagem; cancelada no PC vira o cancelamento, sem pessoa (foi
/// quem estava no PC). Um reenvio do mesmo desfecho não grava de novo.
/// </summary>
internal sealed class PcPowerOutcomeRecorder(
    PcPowerCountdowns countdowns, PairingAuditWriter audit, DevicesDbContext db, PcPowerNotices? notices = null)
{
    public async Task RecordAsync(string agentSlug, PcPowerNotice outcome, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(outcome);
        var cancelled = string.Equals(outcome.Outcome, "cancelled", StringComparison.Ordinal);
        var auditEvent = (outcome.Action, cancelled) switch
        {
            (_, true) => PairingEvents.PcShutdownCancelled,
            ("SHUTDOWN", false) => PairingEvents.PcShutdownFailed,
            ("RESTART", false) => PairingEvents.PcRestartFailed,
            _ => null,
        };
        if (auditEvent is null || !countdowns.TryRecord(outcome.CountdownId))
        {
            return;
        }

        // Só o desfecho da contagem mais recente chega ao app: um atrasado nunca esconde o "cancelar" de outra que segue viva.
        if (countdowns.IsCurrent(agentSlug, outcome.CountdownId))
        {
            notices?.Set(agentSlug, outcome);
        }

        var countdown = countdowns.Take(agentSlug, outcome.CountdownId);
        // Sem a lembrança (API reiniciada, contagem velha, ação diferente): fica na trilha do agente, sem a pessoa.
        if (countdown is not null && !string.Equals(countdown.Action, outcome.Action, StringComparison.Ordinal))
        {
            countdown = null;
        }

        var agentId = countdown?.AgentId ?? await db.Agents.AsNoTracking()
            .Where(a => a.Slug == agentSlug)
            .Select(a => (Guid?)a.Id)
            .SingleOrDefaultAsync(cancellationToken);
        if (agentId is null)
        {
            return;
        }

        var person = cancelled ? null : countdown;
        audit.Add(auditEvent, person?.Client ?? new ClientInfo(null, null), agentId: agentId, userId: person?.UserId);
        await db.SaveChangesAsync(cancellationToken);
    }
}
