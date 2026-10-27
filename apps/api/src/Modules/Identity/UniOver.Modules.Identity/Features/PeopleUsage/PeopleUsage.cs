using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Persistence;
using UniOver.SharedKernel.Usage;

namespace UniOver.Modules.Identity.Features.PeopleUsage;

/// <summary>Quantas vezes algo aconteceu nos últimos 7 e 30 dias.</summary>
internal sealed record PersonUsageCounts(int Last7Days, int Last30Days);

/// <summary>
/// O uso de uma conta como o dono o vê: o último acesso e as sessões ativas (do próprio Identity) e as contagens que os
/// outros módulos entregam pelas portas. Nunca leva e-mail, IP, tecla nem conteúdo de treino.
/// </summary>
/// <param name="LastAccessAt">Último uso de uma sessão (renovação do acesso); nulo se a conta nunca entrou.</param>
/// <param name="ActiveSessions">Sessões que ainda valem (famílias de refresh sem uso, revogação ou vencimento).</param>
/// <param name="TvCommands">Comandos que chegaram à TV (tecla, texto, app, ligar, desligar).</param>
/// <param name="Workouts">Treinos terminados, pela data em que começaram.</param>
internal sealed record PersonUsage(
    Guid Id,
    string DisplayName,
    string Role,
    DateTimeOffset? DisabledAt,
    DateTimeOffset? LastAccessAt,
    int ActiveSessions,
    PersonUsageCounts TvCommands,
    PersonUsageCounts Workouts);

/// <summary>
/// Junta o uso por pessoa. Mora no Identity porque as contas e as sessões são dele; os outros módulos entram só pela
/// porta <see cref="IPersonUsageSource"/> (SharedKernel), sem que o Identity conheça o módulo nem a tabela.
/// </summary>
internal sealed class PeopleUsageHandler(
    IdentityDbContext db, IEnumerable<IPersonUsageSource> sources, TimeProvider time)
{
    public async Task<IReadOnlyList<PersonUsage>> HandleAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var since7 = now.AddDays(-7);
        var since30 = now.AddDays(-30);

        var people = await db.Users.AsNoTracking()
            .OrderBy(u => u.Role).ThenBy(u => u.CreatedAt)
            .Select(u => new { u.Id, u.DisplayName, u.Role, u.DisabledAt })
            .ToListAsync(cancellationToken);
        var ids = people.ConvertAll(p => p.Id);

        var lastAccess = await db.RefreshTokens.AsNoTracking()
            .Where(t => ids.Contains(t.UserId))
            .GroupBy(t => t.UserId)
            .Select(g => new { UserId = g.Key, At = g.Max(t => t.UsedAt ?? t.CreatedAt) })
            .ToDictionaryAsync(r => r.UserId, r => r.At, cancellationToken);

        var sessions = await db.RefreshTokens.AsNoTracking()
            .Where(t => ids.Contains(t.UserId) && t.UsedAt == null && t.RevokedAt == null && t.ExpiresAt > now)
            .GroupBy(t => t.UserId)
            .Select(g => new { UserId = g.Key, Count = g.Select(t => t.FamilyId).Distinct().Count() })
            .ToDictionaryAsync(r => r.UserId, r => r.Count, cancellationToken);

        var counts = new Dictionary<string, IReadOnlyDictionary<Guid, UsageCount>>(StringComparer.Ordinal);
        foreach (var source in sources)
        {
            counts[source.Key] = await source.CountAsync(ids, since7, since30, cancellationToken);
        }

        return [.. people.Select(p => new PersonUsage(
            p.Id,
            p.DisplayName,
            p.Role,
            p.DisabledAt,
            lastAccess.TryGetValue(p.Id, out var at) ? at : null,
            sessions.GetValueOrDefault(p.Id),
            Of(counts, UsageKeys.TvCommands, p.Id),
            Of(counts, UsageKeys.Workouts, p.Id)))];
    }

    private static PersonUsageCounts Of(Dictionary<string, IReadOnlyDictionary<Guid, UsageCount>> counts, string key, Guid id) =>
        counts.TryGetValue(key, out var byUser) && byUser.TryGetValue(id, out var value)
            ? new PersonUsageCounts(value.Last7Days, value.Last30Days)
            : new PersonUsageCounts(0, 0);
}

internal static class PeopleUsageEndpoint
{
    public static void MapPeopleUsage(this IEndpointRouteBuilder group) =>
        group.MapGet("/people-usage", HandleAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<IReadOnlyList<PersonUsage>>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(PeopleUsageHandler handler, CancellationToken cancellationToken) =>
        TypedResults.Ok(await handler.HandleAsync(cancellationToken));
}
