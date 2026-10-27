using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Training.Domain.Sessions;
using UniOver.Modules.Training.Persistence;
using UniOver.SharedKernel.Usage;

namespace UniOver.Modules.Training.Features.Sessions;

/// <summary>Conta os treinos terminados (e não apagados) por pessoa, pela data em que começaram. Só números: nada do conteúdo do treino sai.</summary>
internal sealed class TrainingUsageSource(TrainingDbContext db) : IPersonUsageSource
{
    public const string UsageKey = UsageKeys.Workouts;

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
        var rows = await db.Set<Session>().AsNoTracking()
            .Where(s => ids.Contains(s.UserId) && s.DeletedAt == null && s.FinishedAt != null && s.StartedAt >= since30)
            .GroupBy(s => s.UserId)
            .Select(g => new { UserId = g.Key, Last30 = g.Count(), Last7 = g.Count(s => s.StartedAt >= since7) })
            .ToListAsync(cancellationToken);

        return rows.ToDictionary(r => r.UserId, r => new UsageCount(r.Last7, r.Last30));
    }
}
