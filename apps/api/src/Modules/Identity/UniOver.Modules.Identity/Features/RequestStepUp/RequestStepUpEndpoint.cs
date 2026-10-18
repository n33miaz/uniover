using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.RequestStepUp;

internal static class RequestStepUpEndpoint
{
    public static void MapRequestStepUp(this IEndpointRouteBuilder group) =>
        group.MapPost("/step-up/options", HandleAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Login);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        RequestStepUpRequest? request,
        RequestStepUpHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        if (!StepUp.IsValidAction(request?.Action))
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["action"] = ["Informe a ação: minúsculas, dígitos e '.' ou '-', até 64 caracteres."],
            });
        }

        var response = await handler.HandleAsync(userId, request!.Action!, cancellationToken);
        return response is null ? IdentityProblems.NoPasskey() : TypedResults.Ok(response);
    }
}
