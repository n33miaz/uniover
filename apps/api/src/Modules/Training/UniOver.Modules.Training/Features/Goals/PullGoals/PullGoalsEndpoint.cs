using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Goals;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Goals.PullGoals;

internal sealed record PullGoalsQuery(Guid UserId, PullCursor? After, int Limit);

internal sealed record PullGoalsResponse(IReadOnlyList<GoalResponse> Items, string? NextCursor);

internal static class PullGoalsValidator
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

internal sealed class PullGoalsHandler(TrainingDbContext db)
{
    /// <summary>
    /// As metas do usuário em páginas ordenadas por (instante, id), lápides incluídas. Toda consulta filtra pelo usuário da
    /// sessão: a meta de outra pessoa nunca aparece.
    /// </summary>
    public async Task<PullGoalsResponse> HandleAsync(PullGoalsQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        var userId = query.UserId;
        var rows = db.Set<Goal>().AsNoTracking().Where(g => g.UserId == userId);

        if (query.After is { } after)
        {
            var stamp = after.UpdatedAt;
            var id = after.Id;
            rows = rows.Where(g => g.UpdatedAt > stamp || (g.UpdatedAt == stamp && g.Id.CompareTo(id) > 0));
        }

        var page = await rows
            .OrderBy(g => g.UpdatedAt)
            .ThenBy(g => g.Id)
            .Take(query.Limit)
            .ToListAsync(cancellationToken);

        var items = page.Select(GoalResponse.From).ToList();
        var next = page.Count > 0
            ? new PullCursor(page[^1].UpdatedAt, page[^1].Id).Encode()
            : query.After?.Encode();
        return new PullGoalsResponse(items, next);
    }
}

internal static class PullGoalsEndpoint
{
    public static void MapPullGoals(this IEndpointRouteBuilder group) =>
        group.MapGet("/goals", HandleAsync).RequireAuthorization(TrainingAuth.Module)
            .Produces<PullGoalsResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        PullGoalsHandler handler,
        string? after,
        int? limit,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return GoalProblems.Unauthenticated();
        }

        var errors = PullGoalsValidator.Validate(after, limit, out var cursor, out var pageSize);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        return TypedResults.Ok(await handler.HandleAsync(new PullGoalsQuery(userId, cursor, pageSize), cancellationToken));
    }
}
