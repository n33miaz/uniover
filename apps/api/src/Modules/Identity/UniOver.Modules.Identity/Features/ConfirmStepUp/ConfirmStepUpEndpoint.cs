using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.ConfirmStepUp;

internal static class ConfirmStepUpEndpoint
{
    public static void MapConfirmStepUp(this IEndpointRouteBuilder group) =>
        group.MapPost("/step-up/complete", HandleAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<ConfirmStepUpResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        ICurrentUser current,
        ConfirmStepUpRequest? request,
        ConfirmStepUpHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var errors = new Dictionary<string, string[]>();
        if (request?.ChallengeId is not { } challengeId || challengeId == Guid.Empty)
        {
            errors["challengeId"] = ["Informe o desafio recebido."];
        }

        if (request?.Credential?.Response is null)
        {
            errors["credential"] = ["Informe a resposta do autenticador."];
        }

        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var confirmed = await handler.HandleAsync(
            new ConfirmStepUpCommand(userId, sessionId, request!.ChallengeId!.Value, request.Credential!, ClientInfo.From(http)),
            cancellationToken);

        return confirmed is null ? IdentityProblems.StepUpFailed() : TypedResults.Ok(confirmed);
    }
}
