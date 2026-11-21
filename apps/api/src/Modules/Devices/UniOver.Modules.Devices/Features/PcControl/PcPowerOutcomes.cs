using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// As contagens de desligar ou reiniciar que o agente aceitou há pouco, pelo identificador opaco de cada uma (o <c>id</c> do comando
/// <c>pc.power</c> que a agendou): quem pediu, de onde, e qual é a mais recente de cada agente. O agente só avisa o desfecho depois
/// (<c>pc.power.outcome.v1</c>, com o mesmo identificador), já sem o pedido HTTP: a pessoa da linha de auditoria sai daqui, e só da
/// contagem certa (um desfecho atrasado de outra contagem nunca leva a pessoa errada). Em memória e da instância: com a API reiniciada,
/// a falha ainda é gravada, só sem a pessoa. Saber se um desfecho já foi gravado NÃO é daqui: é do banco
/// (<see cref="Domain.PcPowerOutcomeReceipt"/>), que sobrevive ao reinício e vale para qualquer instância.
/// </summary>
internal sealed class PcPowerCountdowns(TimeProvider time)
{
    /// <summary>Bem mais que a contagem mais longa do agente (e que os 5 min em que o app oferece cancelar).</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);

    private readonly object _gate = new();
    private readonly Dictionary<Guid, PcPowerCountdown> _countdowns = [];
    private readonly Dictionary<string, Guid> _latest = new(StringComparer.Ordinal);

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
/// quem estava no PC).
/// <para>
/// Cada desfecho (agente, contagem e desfecho) é gravado uma vez, e quem decide é o banco: o recibo
/// (<see cref="PcPowerOutcomeReceipt"/>) entra com <c>ON CONFLICT DO NOTHING</c> na mesma transação da linha de auditoria. Só quem de
/// fato incluiu o recibo grava a auditoria e avisa o app; um reenvio (mesmo depois de a API reiniciar, ou em outra instância) não
/// inclui nada e só é confirmado. Dois envios iguais ao mesmo tempo: o segundo espera o índice único até o primeiro terminar; se o
/// primeiro falhou (transação desfeita, sem recibo), o segundo grava. A pessoa só é consumida e o app só fica sabendo depois da
/// transação confirmada: se a gravação falha, nada disso acontece e o reenvio do agente grava.
/// </para>
/// <para>
/// O aviso ao app (<see cref="PcPowerNotices"/>) é volátil: fica na memória da instância e sai depois da transação. Se a API cair
/// entre a confirmação e o aviso, o reenvio encontra o recibo, é confirmado e não avisa de novo. O que fica garantido no banco é o
/// recibo e a linha de auditoria.
/// </para>
/// </summary>
internal sealed class PcPowerOutcomeRecorder(
    PcPowerCountdowns countdowns, PairingAuditWriter audit, DevicesDbContext db, TimeProvider time, PcPowerNotices? notices = null)
{
    /// <summary>
    /// Grava o desfecho, se ainda não foi gravado. Ao voltar, ele está resolvido (gravado agora, já gravado antes, ou sem como gravar,
    /// como um agente que não existe mais) e o agente pode esquecê-lo. Falha do banco sobe, sem nada gravado.
    /// </summary>
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
        if (auditEvent is null)
        {
            return;
        }

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
        if (agentId is not null && !await RecordOnceAsync(agentId.Value, outcome, auditEvent, cancelled ? null : countdown, cancellationToken))
        {
            // Já gravado antes (o agente reenviou porque a confirmação se perdeu): nada de nova linha nem de novo aviso.
            return;
        }

        // Só o desfecho da contagem mais recente chega ao app: um atrasado nunca esconde o "cancelar" de outra que segue viva.
        if (countdowns.IsCurrent(agentSlug, outcome.CountdownId))
        {
            notices?.Set(agentSlug, outcome);
        }

        countdowns.Take(agentSlug, outcome.CountdownId);
    }

    /// <summary>
    /// Inclui o recibo e, só se ele entrou agora, a linha de auditoria, numa transação. <c>false</c> quando o recibo já existia.
    /// </summary>
    private async Task<bool> RecordOnceAsync(
        Guid agentId, PcPowerNotice outcome, string auditEvent, PcPowerCountdown? person, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var inserted = await db.Database.ExecuteSqlAsync(
            $"""
            INSERT INTO devices.pc_power_outcome_receipts (agent_id, countdown_id, outcome, recorded_at)
            VALUES ({agentId}, {outcome.CountdownId}, {outcome.Outcome}, {now})
            ON CONFLICT DO NOTHING
            """,
            cancellationToken);
        if (inserted == 0)
        {
            await transaction.RollbackAsync(cancellationToken);
            return false;
        }

        audit.Add(auditEvent, person?.Client ?? new ClientInfo(null, null), agentId: agentId, userId: person?.UserId);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return true;
    }
}

/// <summary>
/// Apaga os recibos de desfecho de energia que passaram de <see cref="PcPowerOutcomeReceipt.Retention"/>. Entra na lista do serviço de
/// retenção que já existe (<c>AuditPurge</c>, um despertar por dia): sem laço próprio, para o banco gratuito poder dormir. Com a limpeza
/// diária, um recibo dura entre 25 h e pouco mais de dois dias; são poucas linhas pequenas.
/// </summary>
internal static class PcPowerOutcomeRetention
{
    public const string JobName = "devices_pc_power_outcomes";

    public static async Task<int> PurgeExpiredAsync(DevicesDbContext db, TimeProvider time, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(time);
        var floor = time.GetUtcNow() - PcPowerOutcomeReceipt.Retention;
        return await db.PcPowerOutcomeReceipts.Where(r => r.RecordedAt < floor).ExecuteDeleteAsync(cancellationToken);
    }

    public static IServiceCollection AddPcPowerOutcomeRetention(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton(new AuditPurgeJob(
            JobName,
            async (provider, cancellationToken) => await PurgeExpiredAsync(
                provider.GetRequiredService<DevicesDbContext>(), provider.GetRequiredService<TimeProvider>(), cancellationToken)));
        return services;
    }
}
