using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Routines.PullRoutines;

internal sealed record PullRoutinesQuery(Guid UserId, PullCursor? After, int Limit);

internal sealed record PullRoutinesResponse(IReadOnlyList<RoutineResponse> Items, string? NextCursor);

internal static class PullRoutinesValidator
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

internal sealed class PullRoutinesHandler(TrainingDbContext db)
{
    /// <summary>
    /// As rotinas do usuário com os itens, em páginas ordenadas por (instante, id), lápides incluídas. Toda consulta
    /// filtra pelo usuário da sessão: a rotina de outra pessoa nunca aparece.
    /// </summary>
    public async Task<PullRoutinesResponse> HandleAsync(PullRoutinesQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        var userId = query.UserId;
        var rows = db.Set<Routine>().AsNoTracking().Where(r => r.UserId == userId);

        if (query.After is { } after)
        {
            var stamp = after.UpdatedAt;
            var id = after.Id;
            rows = rows.Where(r => r.UpdatedAt > stamp || (r.UpdatedAt == stamp && r.Id.CompareTo(id) > 0));
        }

        var page = await rows
            .OrderBy(r => r.UpdatedAt)
            .ThenBy(r => r.Id)
            .Take(query.Limit)
            .Include(r => r.Items)
            .ToListAsync(cancellationToken);

        var items = page.Select(RoutineResponse.From).ToList();
        var next = page.Count > 0
            ? new PullCursor(page[^1].UpdatedAt, page[^1].Id).Encode()
            : query.After?.Encode();
        return new PullRoutinesResponse(items, next);
    }
}

internal static class PullRoutinesEndpoint
{
    public static void MapPullRoutines(this IEndpointRouteBuilder group) =>
        group.MapGet("/routines", HandleAsync).RequireAuthorization()
            .Produces<PullRoutinesResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        PullRoutinesHandler handler,
        string? after,
        int? limit,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RoutineProblems.Unauthenticated();
        }

        var errors = PullRoutinesValidator.Validate(after, limit, out var cursor, out var pageSize);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        return TypedResults.Ok(await handler.HandleAsync(new PullRoutinesQuery(userId, cursor, pageSize), cancellationToken));
    }
}
