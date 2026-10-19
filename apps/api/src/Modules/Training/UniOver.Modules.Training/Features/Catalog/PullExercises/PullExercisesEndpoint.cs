using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Features.Catalog.PullExercises;

internal static class PullExercisesEndpoint
{
    public static void MapPullExercises(this IEndpointRouteBuilder group) =>
        group.MapGet("/exercises", HandleAsync).RequireAuthorization()
            .Produces<PullExercisesResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        PullExercisesHandler handler,
        string? after,
        int? limit,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return CatalogProblems.Unauthenticated();
        }

        var errors = PullExercisesValidator.Validate(after, limit, out var cursor, out var pageSize);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        return TypedResults.Ok(await handler.HandleAsync(new PullExercisesQuery(userId, cursor, pageSize), cancellationToken));
    }
}

internal static class PullExercisesValidator
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
