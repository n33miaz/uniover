using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Body;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Body.PullBodyEntries;

internal sealed record PullBodyEntriesQuery(Guid UserId, PullCursor? After, int Limit);

internal sealed record PullBodyEntriesResponse(IReadOnlyList<BodyEntryResponse> Items, string? NextCursor);

/// <summary>Validação do <c>after</c> e do <c>limit</c>, a mesma para a leitura de medições e a do perfil.</summary>
internal static class PullBodyValidator
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

internal sealed class PullBodyEntriesHandler(TrainingDbContext db)
{
    /// <summary>
    /// As medições do usuário em páginas ordenadas por (instante, id), lápides incluídas. Toda consulta filtra pelo usuário da
    /// sessão: a medição de outra pessoa nunca aparece.
    /// </summary>
    public async Task<PullBodyEntriesResponse> HandleAsync(PullBodyEntriesQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        var userId = query.UserId;
        var rows = db.Set<BodyEntry>().AsNoTracking().Where(e => e.UserId == userId);

        if (query.After is { } after)
        {
            var stamp = after.UpdatedAt;
            var id = after.Id;
            rows = rows.Where(e => e.UpdatedAt > stamp || (e.UpdatedAt == stamp && e.Id.CompareTo(id) > 0));
        }

        var page = await rows
            .OrderBy(e => e.UpdatedAt)
            .ThenBy(e => e.Id)
            .Take(query.Limit)
            .ToListAsync(cancellationToken);

        var items = page.Select(BodyEntryResponse.From).ToList();
        var next = page.Count > 0
            ? new PullCursor(page[^1].UpdatedAt, page[^1].Id).Encode()
            : query.After?.Encode();
        return new PullBodyEntriesResponse(items, next);
    }
}

internal static class PullBodyEntriesEndpoint
{
    public static void MapPullBodyEntries(this IEndpointRouteBuilder group) =>
        group.MapGet("/body/entries", HandleAsync).RequireAuthorization(TrainingAuth.Module)
            .Produces<PullBodyEntriesResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        PullBodyEntriesHandler handler,
        string? after,
        int? limit,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return BodyProblems.Unauthenticated();
        }

        var errors = PullBodyValidator.Validate(after, limit, out var cursor, out var pageSize);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        return TypedResults.Ok(await handler.HandleAsync(new PullBodyEntriesQuery(userId, cursor, pageSize), cancellationToken));
    }
}
