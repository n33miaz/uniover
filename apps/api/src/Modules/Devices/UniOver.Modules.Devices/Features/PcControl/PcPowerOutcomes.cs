using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// As contagens de desligar ou reiniciar que o agente aceitou há pouco, pelo identificador opaco de cada uma (o <c>id</c> do comando
/// <c>pc.power</c> que a agendou): quem pediu, de onde, e qual é a mais recente de cada agente. O agente só avisa o desfecho depois
/// (<c>pc.power.outcome.v1</c>, com o mesmo identificador), já sem o pedido HTTP: a pessoa da linha de auditoria sai daqui, e só da
/// contagem certa (um desfecho atrasado de outra contagem nunca leva a pessoa errada). Cada desfecho (pela contagem e pelo desfecho) é
/// gravado uma vez: quem grava o reserva antes (<see cref="Claim"/>), o marca como gravado só depois de a linha de auditoria ser salva
/// (<see cref="Recorded"/>) e o devolve se a gravação falhou (<see cref="Release"/>), para o reenvio do agente gravá-lo. Em memória e da
/// instância: com a API reiniciada, a falha ainda é gravada, só sem a pessoa.
/// </summary>
internal sealed class PcPowerCountdowns(TimeProvider time)
{
    /// <summary>Bem mais que a contagem mais longa do agente (e que os 5 min em que o app oferece cancelar).</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);

    /// <summary>
    /// Por quanto tempo o desfecho gravado é lembrado: um pouco mais que o dia em que o agente segue reenviando o que não teve confirmação
    /// (na memória e na marca em disco da contagem perdida). Um reenvio dentro dessa janela nunca vira outra linha na auditoria. Limite
    /// conhecido: a lembrança é desta instância; uma API reiniciada (ou outra instância) aceitaria o reenvio como novo.
    /// </summary>
    public static readonly TimeSpan RecordedLifetime = TimeSpan.FromHours(25);

    private readonly object _gate = new();
    private readonly Dictionary<Guid, PcPowerCountdown> _countdowns = [];
    private readonly Dictionary<string, Guid> _latest = new(StringComparer.Ordinal);
    private readonly Dictionary<(Guid CountdownId, string Outcome), DateTimeOffset> _recorded = [];
    private readonly HashSet<(Guid CountdownId, string Outcome)> _recording = [];

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

    /// <summary>
    /// A contagem é a que a instância sabe estar correndo naquele agente: a mais recente dele, ainda lembrada (sem desfecho, sem
    /// cancelamento e dentro de <see cref="Lifetime"/>). Sem saber (API reiniciada), não é.
    /// </summary>
    public bool IsLive(string agentSlug, Guid countdownId)
    {
        lock (_gate)
        {
            return _latest.TryGetValue(agentSlug, out var latest)
                && latest == countdownId
                && _countdowns.TryGetValue(countdownId, out var countdown)
                && string.Equals(countdown.Slug, agentSlug, StringComparison.Ordinal)
                && time.GetUtcNow() - countdown.At <= Lifetime;
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

    /// <summary>
    /// Reserva a gravação do desfecho <paramref name="outcome"/> da contagem: <see cref="PcPowerOutcomeClaim.Mine"/> (grave e chame
    /// <see cref="Recorded"/> ou <see cref="Release"/>), <see cref="PcPowerOutcomeClaim.Recorded"/> (já gravado: o agente reenviou) ou
    /// <see cref="PcPowerOutcomeClaim.Busy"/> (outro envio está gravando agora).
    /// </summary>
    public PcPowerOutcomeClaim Claim(Guid countdownId, string outcome)
    {
        lock (_gate)
        {
            Prune();
            var key = (countdownId, outcome);
            if (_recorded.ContainsKey(key))
            {
                return PcPowerOutcomeClaim.Recorded;
            }

            return _recording.Add(key) ? PcPowerOutcomeClaim.Mine : PcPowerOutcomeClaim.Busy;
        }
    }

    /// <summary>A linha de auditoria do desfecho foi salva: reenvios dele não gravam de novo.</summary>
    public void Recorded(Guid countdownId, string outcome)
    {
        lock (_gate)
        {
            _recording.Remove((countdownId, outcome));
            _recorded[(countdownId, outcome)] = time.GetUtcNow();
        }
    }

    /// <summary>A gravação falhou: o reenvio do agente pode gravar o desfecho.</summary>
    public void Release(Guid countdownId, string outcome)
    {
        lock (_gate)
        {
            _recording.Remove((countdownId, outcome));
        }
    }

    /// <summary>A contagem <paramref name="countdownId"/> daquele agente, se ainda vale; fica aqui (ver <see cref="Take"/>).</summary>
    public PcPowerCountdown? Peek(string agentSlug, Guid countdownId)
    {
        lock (_gate)
        {
            return _countdowns.TryGetValue(countdownId, out var countdown)
                && string.Equals(countdown.Slug, agentSlug, StringComparison.Ordinal)
                && time.GetUtcNow() - countdown.At <= Lifetime
                    ? countdown
                    : null;
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

        foreach (var key in _recorded.Where(r => now - r.Value > RecordedLifetime).Select(r => r.Key).ToList())
        {
            _recorded.Remove(key);
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

/// <summary>A reserva da gravação de um desfecho (ver <see cref="PcPowerCountdowns.Claim"/>).</summary>
internal enum PcPowerOutcomeClaim
{
    Mine,
    Recorded,
    Busy,
}

/// <summary>Uma contagem aceita pelo agente: o agente (Guid), quem pediu, de onde, e a ação (<c>SHUTDOWN</c> ou <c>RESTART</c>).</summary>
internal sealed record PcPowerCountdown(
    Guid AgentId, Guid UserId, ClientInfo Client, string Action, string Slug = "", DateTimeOffset At = default);

/// <summary>
/// O desfecho que o agente avisou (<c>pc.power.outcome.v1</c>): a contagem não terminou no pedido. Recusada ou perdida vira a linha de
/// falha da ação, com quem pediu quando a instância ainda lembra daquela contagem; cancelada no PC vira o cancelamento, sem pessoa (foi
/// quem estava no PC). A contagem só é marcada como gravada, a pessoa só é consumida e o app só fica sabendo depois de a linha ser salva:
/// se a gravação falha, nada disso acontece e o reenvio do agente grava. Um reenvio do que já foi gravado não grava de novo.
/// </summary>
internal sealed class PcPowerOutcomeRecorder(
    PcPowerCountdowns countdowns, PairingAuditWriter audit, DevicesDbContext db, PcPowerNotices? notices = null)
{
    /// <summary>
    /// Grava o desfecho. <c>true</c> quando ele está resolvido (gravado agora, já gravado antes, ou sem como gravar, como um agente que não
    /// existe mais): o agente pode esquecê-lo. <c>false</c> quando outro envio do mesmo desfecho ainda está gravando. Falha do banco sobe.
    /// </summary>
    public async Task<bool> RecordAsync(string agentSlug, PcPowerNotice outcome, CancellationToken cancellationToken)
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
        if (auditEvent is null)
        {
            return true;
        }

        switch (countdowns.Claim(outcome.CountdownId, outcome.Outcome))
        {
            case PcPowerOutcomeClaim.Recorded:
                return true;
            case PcPowerOutcomeClaim.Busy:
                return false;
        }

        try
        {
            var countdown = countdowns.Peek(agentSlug, outcome.CountdownId);
            // Sem a lembrança (API reiniciada, contagem velha, ação diferente): fica na trilha do agente, sem a pessoa.
            if (countdown is not null && !string.Equals(countdown.Action, outcome.Action, StringComparison.Ordinal))
            {
                countdown = null;
            }

            var agentId = countdown?.AgentId ?? await db.Agents.AsNoTracking()
                .Where(a => a.Slug == agentSlug)
                .Select(a => (Guid?)a.Id)
                .SingleOrDefaultAsync(cancellationToken);
            if (agentId is not null)
            {
                var person = cancelled ? null : countdown;
                audit.Add(auditEvent, person?.Client ?? new ClientInfo(null, null), agentId: agentId, userId: person?.UserId);
                await db.SaveChangesAsync(cancellationToken);
            }
        }
        catch
        {
            countdowns.Release(outcome.CountdownId, outcome.Outcome);
            throw;
        }

        countdowns.Recorded(outcome.CountdownId, outcome.Outcome);
        // Só o desfecho da contagem mais recente chega ao app: um atrasado nunca esconde o "cancelar" de outra que segue viva.
        if (countdowns.IsCurrent(agentSlug, outcome.CountdownId))
        {
            notices?.Set(agentSlug, outcome);
        }

        countdowns.Take(agentSlug, outcome.CountdownId);
        return true;
    }
}
