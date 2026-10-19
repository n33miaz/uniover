using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Routines.UpsertRoutine;

internal static class UpsertRoutineEndpoint
{
    public static void MapUpsertRoutine(this IEndpointRouteBuilder group) =>
        group.MapPut("/routines/{id:guid}", HandleAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<RoutineResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

    private static async Task<IResult> HandleAsync(
        Guid id,
        UpsertRoutineRequest? request,
        ICurrentUser current,
        UpsertRoutineHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RoutineProblems.Unauthenticated();
        }

        var errors = UpsertRoutineValidator.Validate(id, request, userId, out var command);
        if (errors.Count > 0 || command is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(command, cancellationToken);
        return result.Outcome switch
        {
            UpsertRoutineOutcome.Ok => TypedResults.Ok(result.Routine),
            UpsertRoutineOutcome.ExerciseNotFound => RoutineProblems.ExerciseNotFound(),
            UpsertRoutineOutcome.SupersetNotContiguous => RoutineProblems.SupersetNotContiguous(),
            UpsertRoutineOutcome.ClockAhead => RoutineProblems.ClientClockAhead(),
            _ => RoutineProblems.NotFound(),
        };
    }
}
