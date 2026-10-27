using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.SharedKernel.Usage;

namespace UniOver.Modules.Tv.Audit;

/// <summary>
/// Conta os comandos que chegaram à TV (tecla, texto, app, ligar, desligar) por pessoa, lendo <c>command_audit</c>.
/// Edição de atalhos, troca de computador e a anotação de teto não são uso da TV e ficam de fora.
/// </summary>
internal sealed class TvUsageSource(TvDbContext db) : IPersonUsageSource
{
    public const string UsageKey = UsageKeys.TvCommands;

    private static readonly string[] Commands =
    [
        TvCommandNames.Key,
        TvCommandNames.Text,
        TvCommandNames.AppLaunch,
        TvCommandNames.Wake,
        TvCommandNames.PowerOff,
    ];

    public string Key => UsageKey;

    public async Task<IReadOnlyDictionary<Guid, UsageCount>> CountAsync(
        IReadOnlyCollection<Guid> userIds, DateTimeOffset since7, DateTimeOffset since30, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(userIds);
        if (userIds.Count == 0)
        {
            return new Dictionary<Guid, UsageCount>();
        }

        var ids = userIds.ToArray();
        var rows = await db.CommandAudit.AsNoTracking()
            .Where(r => ids.Contains(r.UserId) && r.OccurredAt >= since30 && Commands.Contains(r.Command))
            .GroupBy(r => r.UserId)
            .Select(g => new { UserId = g.Key, Last30 = g.Count(), Last7 = g.Count(r => r.OccurredAt >= since7) })
            .ToListAsync(cancellationToken);

        return rows.ToDictionary(r => r.UserId, r => new UsageCount(r.Last7, r.Last30));
    }
}
