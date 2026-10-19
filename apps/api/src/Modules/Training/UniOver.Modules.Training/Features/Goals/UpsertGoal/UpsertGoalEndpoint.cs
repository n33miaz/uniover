using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Goals.UpsertGoal;

internal static class UpsertGoalEndpoint
{
    public static void MapUpsertGoal(this IEndpointRouteBuilder group) =>
        group.MapPut("/goals/{kind}", HandleAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<GoalResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

    private static async Task<IResult> HandleAsync(
        string kind,
        UpsertGoalRequest? request,
        ICurrentUser current,
        UpsertGoalHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return GoalProblems.Unauthenticated();
        }

        var errors = UpsertGoalValidator.Validate(kind, request, userId, out var command);
        if (errors.Count > 0 || command is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(command, cancellationToken);
        return result.Outcome switch
        {
            UpsertGoalOutcome.Ok => TypedResults.Ok(result.Goal),
            UpsertGoalOutcome.ClockAhead => GoalProblems.ClientClockAhead(),
            _ => GoalProblems.ExerciseNotFound(),
        };
    }
}
