using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Sessions.UpsertSet;

internal static class UpsertSetEndpoint
{
    public static void MapUpsertSet(this IEndpointRouteBuilder group) =>
        group.MapPut("/sessions/{sessionId:guid}/sets/{id:guid}", HandleAsync)
            .RequireAuthorization(TrainingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<SetResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

    private static async Task<IResult> HandleAsync(
        Guid sessionId,
        Guid id,
        UpsertSetRequest? request,
        ICurrentUser current,
        UpsertSetHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return SessionProblems.Unauthenticated();
        }

        var errors = UpsertSetValidator.Validate(sessionId, id, request, userId, out var command);
        if (errors.Count > 0 || command is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(command, cancellationToken);
        return result.Outcome switch
        {
            UpsertSetOutcome.Ok => TypedResults.Ok(result.Set),
            UpsertSetOutcome.ExerciseNotFound => SessionProblems.ExerciseNotFound(),
            UpsertSetOutcome.ShapeInvalid => SessionProblems.SetShapeInvalid(),
            UpsertSetOutcome.ClockAhead => SessionProblems.ClientClockAhead(),
            _ => SessionProblems.SessionNotFound(),
        };
    }
}
