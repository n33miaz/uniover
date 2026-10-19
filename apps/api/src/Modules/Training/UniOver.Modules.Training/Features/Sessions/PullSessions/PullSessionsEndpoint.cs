using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Sessions;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Sessions.PullSessions;

internal sealed record PullSessionsQuery(Guid UserId, PullCursor? After, int Limit);

internal sealed record PullSessionsResponse(IReadOnlyList<SessionResponse> Items, string? NextCursor);

/// <summary>Validação do <c>after</c> e do <c>limit</c>, a mesma para a leitura de treinos e a de séries.</summary>
internal static class PullPageValidator
{
    public static Dictionary<string, string[]> Validate(string? after, int? limit, out PullCursor? cursor, out int pageSize)
    {
        var errors = new Dictionary<string, string[]>();
        cursor = null;
        pageSize = limit ?? PullCursor.DefaultLimit;

        if (!string.IsNullOrEmpty(after))
        {
            if (PullCursor.TryDecode(after, out var decoded))
            {
                cursor = decoded;
            }
            else
            {
                errors["after"] = ["O cursor não é válido."];
            }
        }

        if (pageSize is < 1 or > PullCursor.MaxLimit)
        {
            errors["limit"] = [$"O limite deve ficar entre 1 e {PullCursor.MaxLimit}."];
        }

        return errors;
    }
}

internal sealed class PullSessionsHandler(TrainingDbContext db)
{
    /// <summary>
    /// Os treinos do usuário em páginas ordenadas por (instante, id), lápides incluídas. Toda consulta filtra pelo usuário da
    /// sessão: o treino de outra pessoa nunca aparece.
    /// </summary>
    public async Task<PullSessionsResponse> HandleAsync(PullSessionsQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        var userId = query.UserId;
        var rows = db.Set<Session>().AsNoTracking().Where(s => s.UserId == userId);

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

        var items = page.Select(SessionResponse.From).ToList();
        var next = page.Count > 0
            ? new PullCursor(page[^1].UpdatedAt, page[^1].Id).Encode()
            : query.After?.Encode();
        return new PullSessionsResponse(items, next);
    }
}

internal static class PullSessionsEndpoint
{
    public static void MapPullSessions(this IEndpointRouteBuilder group) =>
        group.MapGet("/sessions", HandleAsync).RequireAuthorization()
            .Produces<PullSessionsResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        PullSessionsHandler handler,
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

        return TypedResults.Ok(await handler.HandleAsync(new PullSessionsQuery(userId, cursor, pageSize), cancellationToken));
    }
}
