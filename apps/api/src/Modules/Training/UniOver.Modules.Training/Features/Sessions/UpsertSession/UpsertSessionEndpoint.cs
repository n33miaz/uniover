using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Sessions.UpsertSession;

internal static class UpsertSessionEndpoint
{
    public static void MapUpsertSession(this IEndpointRouteBuilder group) =>
        group.MapPut("/sessions/{id:guid}", HandleAsync)
            .RequireAuthorization(TrainingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<SessionResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

    private static async Task<IResult> HandleAsync(
        Guid id,
        UpsertSessionRequest? request,
        ICurrentUser current,
        UpsertSessionHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return SessionProblems.Unauthenticated();
        }

        var errors = UpsertSessionValidator.Validate(id, request, userId, out var command);
        if (errors.Count > 0 || command is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(command, cancellationToken);
        return result.Outcome switch
        {
            UpsertSessionOutcome.Ok => TypedResults.Ok(result.Session),
            UpsertSessionOutcome.RoutineNotFound => SessionProblems.RoutineNotFound(),
            UpsertSessionOutcome.FinishBeforeStart => SessionProblems.FinishBeforeStart(),
            UpsertSessionOutcome.ClockAhead => SessionProblems.ClientClockAhead(),
            UpsertSessionOutcome.AlreadyOpen when result.Open is { } open =>
                SessionProblems.SessionAlreadyOpen(open.SessionId, open.DeviceId, open.StartedAt),
            _ => SessionProblems.SessionNotFound(),
        };
    }
}
