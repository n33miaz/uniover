using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Retenção oportunista da auditoria: nenhuma tarefa periódica (um laço manteria o Neon acordado). A limpeza roda
/// junto de uma gravação, no máximo uma vez a cada dez minutos, para um "volume +" repetido não pagar duas
/// consultas extras por tecla.
/// </summary>
internal sealed class AuditRetention(TimeProvider time)
{
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(30);
    public const int MaxRows = 5000;
    private static readonly TimeSpan MinimumGap = TimeSpan.FromMinutes(10);

    private readonly object _gate = new();
    private DateTimeOffset? _lastRun;

    /// <summary><c>true</c> quando é hora de limpar (e já marca a hora, para o próximo pedido esperar).</summary>
    public bool TryBegin()
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (_lastRun is { } last && now - last < MinimumGap)
            {
                return false;
            }

            _lastRun = now;
            return true;
        }
    }
}

internal sealed class EfCommandAudit(TvDbContext db, AuditRetention retention, TimeProvider time) : ITvCommandAudit
{
    public async Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(entry);

        db.CommandAudit.Add(entry);
        await db.SaveChangesAsync(cancellationToken);

        if (!retention.TryBegin())
        {
            return;
        }

        var cutoff = time.GetUtcNow() - AuditRetention.MaxAge;
        await db.CommandAudit.Where(a => a.OccurredAt < cutoff).ExecuteDeleteAsync(cancellationToken);

        // Acima do teto, apaga o que passou da linha de número MaxRows (da mais nova para a mais antiga).
        var boundary = await db.CommandAudit
            .OrderByDescending(a => a.OccurredAt)
            .Skip(AuditRetention.MaxRows)
            .Select(a => (DateTimeOffset?)a.OccurredAt)
            .FirstOrDefaultAsync(cancellationToken);
        if (boundary is { } oldest)
        {
            await db.CommandAudit.Where(a => a.OccurredAt <= oldest).ExecuteDeleteAsync(cancellationToken);
        }
    }
}
