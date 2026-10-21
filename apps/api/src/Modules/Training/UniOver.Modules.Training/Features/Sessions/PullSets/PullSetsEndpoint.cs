using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Sessions;
using UniOver.Modules.Training.Features.Sessions.PullSessions;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Sessions.PullSets;

internal sealed record PullSetsQuery(Guid UserId, PullCursor? After, int Limit);

internal sealed record PullSetsResponse(IReadOnlyList<SetResponse> Items, string? NextCursor);

internal sealed class PullSetsHandler(TrainingDbContext db)
{
    /// <summary>
    /// As séries do usuário em páginas ordenadas por (instante, id), lápides incluídas (as séries de um treino apagado
    /// chegam como lápide). Toda consulta filtra pelo usuário da sessão.
    /// </summary>
    public async Task<PullSetsResponse> HandleAsync(PullSetsQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        var userId = query.UserId;
        var rows = db.Set<SessionSet>().AsNoTracking().Where(s => s.UserId == userId);

        if (query.After is { } after)
        {
            var stamp = after.UpdatedAt;
            var id = after.Id;
            rows = rows.Where(s => s.UpdatedAt > stamp || (s.UpdatedAt == stamp && s.Id.CompareTo(id) > 0));
        }

        var page = await rows
            .OrderBy(s => s.UpdatedAt)
            .ThenBy(s => s.Id)
            .Take(query.Limit)
            .ToListAsync(cancellationToken);

        var items = page.Select(SetResponse.From).ToList();
        var next = page.Count > 0
            ? new PullCursor(page[^1].UpdatedAt, page[^1].Id).Encode()
            : query.After?.Encode();
        return new PullSetsResponse(items, next);
    }
}

internal static class PullSetsEndpoint
{
    public static void MapPullSets(this IEndpointRouteBuilder group) =>
        group.MapGet("/sets", HandleAsync).RequireAuthorization(TrainingAuth.Module)
            .Produces<PullSetsResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        PullSetsHandler handler,
        string? after,
        int? limit,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return SessionProblems.Unauthenticated();
        }

        var errors = PullPageValidator.Validate(after, limit, out var cursor, out var pageSize);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        return TypedResults.Ok(await handler.HandleAsync(new PullSetsQuery(userId, cursor, pageSize), cancellationToken));
    }
}
