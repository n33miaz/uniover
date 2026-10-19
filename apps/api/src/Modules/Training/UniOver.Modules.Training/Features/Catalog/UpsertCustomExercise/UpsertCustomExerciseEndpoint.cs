using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Catalog.UpsertCustomExercise;

internal static class UpsertCustomExerciseEndpoint
{
    public static void MapUpsertCustomExercise(this IEndpointRouteBuilder group) =>
        group.MapPut("/exercises/{id:guid}", HandleAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<ExerciseResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

    private static async Task<IResult> HandleAsync(
        Guid id,
        UpsertCustomExerciseRequest? request,
        ICurrentUser current,
        UpsertCustomExerciseHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return CatalogProblems.Unauthenticated();
        }

        var errors = UpsertCustomExerciseValidator.Validate(id, request, userId, out var command);
        if (errors.Count > 0 || command is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(command, cancellationToken);
        return result.Outcome switch
        {
            UpsertOutcome.Ok => TypedResults.Ok(result.Exercise),
            UpsertOutcome.CatalogReadonly => CatalogProblems.CatalogRowReadonly(),
            UpsertOutcome.ClockAhead => CatalogProblems.ClientClockAhead(),
            _ => CatalogProblems.NotFound(),
        };
    }
}
