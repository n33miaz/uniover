using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Foods;
using UniOver.Modules.Training.Features.Foods;
using UniOver.Modules.Training.Features.Body.PullBodyEntries;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Meals.PullMeals;

internal sealed record PullMealsResponse(IReadOnlyList<MealResponse> Items, string? NextCursor);
internal sealed class PullMealsHandler(TrainingDbContext db)
{
    public async Task<PullMealsResponse> HandleAsync(Guid userId, PullCursor? after, int limit, CancellationToken ct)
    {
        var rows = db.Set<MealEntry>().AsNoTracking().Where(e => e.UserId == userId);
        if (after is { } cursor) rows = rows.Where(e => e.UpdatedAt > cursor.UpdatedAt || (e.UpdatedAt == cursor.UpdatedAt && e.Id.CompareTo(cursor.Id) > 0));
        var page = await rows.OrderBy(e => e.UpdatedAt).ThenBy(e => e.Id).Take(limit).ToListAsync(ct);
        return new PullMealsResponse(page.Select(MealResponse.From).ToArray(), page.Count == 0 ? after?.Encode() : new PullCursor(page[^1].UpdatedAt, page[^1].Id).Encode());
    }
}

internal static class PullMealsEndpoint
{
    public static void MapPullMeals(this IEndpointRouteBuilder group) => group.MapGet("/meals", HandleAsync)
        .RequireAuthorization(TrainingAuth.Module).Produces<PullMealsResponse>().ProducesProblem(400).ProducesProblem(401);

    private static async Task<IResult> HandleAsync(string? after, int? limit, ICurrentUser current, PullMealsHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId) return Results.Problem(statusCode: 401, title: "Sessão inválida ou expirada.");
        var errors = PullBodyValidator.Validate(after, limit, out var cursor, out var size);
        if (errors.Count > 0) return ProblemDetailsExtensions.ValidationProblem(errors);
        return Results.Ok(await handler.HandleAsync(userId, cursor, size, ct));
    }
}
