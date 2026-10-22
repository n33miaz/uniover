using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Body.UpsertBodyEntry;

internal static class UpsertBodyEntryEndpoint
{
    public static void MapUpsertBodyEntry(this IEndpointRouteBuilder group) =>
        group.MapPut("/body/entries/{id:guid}", HandleAsync)
            .RequireAuthorization(TrainingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<BodyEntryResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

    private static async Task<IResult> HandleAsync(
        Guid id,
        UpsertBodyEntryRequest? request,
        ICurrentUser current,
        UpsertBodyEntryHandler handler,
        TimeProvider time,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return BodyProblems.Unauthenticated();
        }

        var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
        var errors = UpsertBodyEntryValidator.Validate(id, request, userId, today, out var command);
        if (errors.Count > 0 || command is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(command, cancellationToken);
        return result.Outcome switch
        {
            UpsertBodyEntryOutcome.Ok => TypedResults.Ok(result.Entry),
            UpsertBodyEntryOutcome.Empty => BodyProblems.EntryEmpty(),
            UpsertBodyEntryOutcome.ClockAhead => BodyProblems.ClientClockAhead(),
            _ => BodyProblems.EntryNotFound(),
        };
    }
}
