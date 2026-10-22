using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Foods;
using UniOver.Modules.Training.Features.Body.PullBodyEntries;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Foods.PullFoods;

internal sealed record PullFoodsResponse(IReadOnlyList<FoodResponse> Items, string? NextCursor);
internal sealed class PullFoodsHandler(TrainingDbContext db)
{
    public async Task<PullFoodsResponse> HandleAsync(Guid userId, PullCursor? after, int limit, CancellationToken ct)
    {
        var rows = db.Set<Food>().AsNoTracking().Where(f => f.OwnerUserId == null || f.OwnerUserId == userId);
        if (after is { } cursor) rows = rows.Where(f => f.UpdatedAt > cursor.UpdatedAt || (f.UpdatedAt == cursor.UpdatedAt && f.Id.CompareTo(cursor.Id) > 0));
        var page = await rows.OrderBy(f => f.UpdatedAt).ThenBy(f => f.Id).Take(limit).ToListAsync(ct);
        return new PullFoodsResponse(page.Select(FoodResponse.From).ToArray(), page.Count == 0 ? after?.Encode() : new PullCursor(page[^1].UpdatedAt, page[^1].Id).Encode());
    }
}

internal static class PullFoodsEndpoint
{
    public static void MapPullFoods(this IEndpointRouteBuilder group) => group.MapGet("/foods", HandleAsync)
        .RequireAuthorization(TrainingAuth.Module).Produces<PullFoodsResponse>().ProducesProblem(400).ProducesProblem(401);

    private static async Task<IResult> HandleAsync(string? after, int? limit, ICurrentUser current, PullFoodsHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId) return Results.Problem(statusCode: 401, title: "Sessão inválida ou expirada.");
        var errors = PullBodyValidator.Validate(after, limit, out var cursor, out var size);
        if (errors.Count > 0) return ProblemDetailsExtensions.ValidationProblem(errors);
        return Results.Ok(await handler.HandleAsync(userId, cursor, size, ct));
    }
}
