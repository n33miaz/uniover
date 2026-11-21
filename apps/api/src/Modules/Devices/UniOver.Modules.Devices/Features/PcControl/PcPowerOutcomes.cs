using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// As contagens de desligar ou reiniciar que o agente aceitou há pouco: quem pediu, de onde, e qual a linha de falha se ela não
/// terminar no pedido. O agente só avisa o desfecho depois (<c>pc.power.outcome.v1</c>), já sem o pedido HTTP; é daqui que sai
/// quem vai na linha de auditoria. Em memória e da instância: com a API reiniciada, a falha ainda é gravada, só sem a pessoa.
/// </summary>
internal sealed class PcPowerCountdowns(TimeProvider time)
{
    /// <summary>Bem mais que a contagem mais longa do agente (e que os 5 min em que o app oferece cancelar).</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);

    private readonly object _gate = new();
    private readonly Dictionary<string, PcPowerCountdown> _countdowns = new(StringComparer.Ordinal);

    public void Scheduled(string agentSlug, PcPowerCountdown countdown)
    {
        lock (_gate)
        {
            _countdowns[agentSlug] = countdown with { At = time.GetUtcNow() };
        }
    }

    public void Cancelled(string agentSlug)
    {
        lock (_gate)
        {
            _countdowns.Remove(agentSlug);
        }
    }

    /// <summary>A contagem de agora do agente, se ainda vale; sai daqui (o desfecho só é gravado uma vez).</summary>
    public PcPowerCountdown? Take(string agentSlug)
    {
        lock (_gate)
        {
            if (!_countdowns.Remove(agentSlug, out var countdown))
            {
                return null;
            }

            return time.GetUtcNow() - countdown.At <= Lifetime ? countdown : null;
        }
    }
}

/// <summary>Uma contagem aceita pelo agente: o agente (Guid), quem pediu, de onde, e a ação (<c>SHUTDOWN</c> ou <c>RESTART</c>).</summary>
internal sealed record PcPowerCountdown(Guid AgentId, Guid UserId, ClientInfo Client, string Action, DateTimeOffset At = default);

/// <summary>
/// O desfecho que o agente avisou (<c>pc.power.outcome.v1</c>): a contagem não terminou no pedido (o Windows recusou, ou o agente
/// reiniciou no meio). Vira a linha de falha da ação na auditoria, com quem pediu quando a instância ainda lembra.
/// </summary>
internal sealed class PcPowerOutcomeRecorder(PcPowerCountdowns countdowns, PairingAuditWriter audit, DevicesDbContext db)
{
    public async Task RecordAsync(string agentSlug, string action, CancellationToken cancellationToken)
    {
        var failedEvent = action switch
        {
            "SHUTDOWN" => PairingEvents.PcShutdownFailed,
            "RESTART" => PairingEvents.PcRestartFailed,
            _ => null,
        };
        if (failedEvent is null)
        {
            return;
        }

        var countdown = countdowns.Take(agentSlug);
        // Sem a lembrança (API reiniciada, contagem velha, ação diferente): a falha fica na trilha do agente, sem a pessoa.
        if (countdown is not null && !string.Equals(countdown.Action, action, StringComparison.Ordinal))
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

        audit.Add(failedEvent, countdown?.Client ?? new ClientInfo(null, null), agentId: agentId, userId: countdown?.UserId);
        await db.SaveChangesAsync(cancellationToken);
    }
}
