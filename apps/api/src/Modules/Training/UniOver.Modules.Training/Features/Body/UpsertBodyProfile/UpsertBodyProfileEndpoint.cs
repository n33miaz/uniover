using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Body.UpsertBodyProfile;

internal static class UpsertBodyProfileEndpoint
{
    public static void MapUpsertBodyProfile(this IEndpointRouteBuilder group) =>
        group.MapPut("/body/profile", HandleAsync)
            .RequireAuthorization(TrainingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<BodyProfileResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

    private static async Task<IResult> HandleAsync(
        UpsertBodyProfileRequest? request,
        ICurrentUser current,
        UpsertBodyProfileHandler handler,
        TimeProvider time,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return BodyProblems.Unauthenticated();
        }

        var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
        var errors = UpsertBodyProfileValidator.Validate(request, userId, today, out var command);
        if (errors.Count > 0 || command is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(command, cancellationToken);
        return result.Outcome switch
        {
            UpsertBodyProfileOutcome.Ok => TypedResults.Ok(result.Profile),
            _ => BodyProblems.ClientClockAhead(),
        };
    }
}
