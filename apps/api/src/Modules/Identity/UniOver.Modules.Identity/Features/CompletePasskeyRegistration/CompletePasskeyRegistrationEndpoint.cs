using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.ListPasskeys;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.CompletePasskeyRegistration;

internal static class CompletePasskeyRegistrationEndpoint
{
    public static void MapCompletePasskeyRegistration(this IEndpointRouteBuilder group) =>
        group.MapPost("/passkeys/registration/complete", HandleAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<PasskeySummary>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        ICurrentUser current,
        CompletePasskeyRegistrationRequest? request,
        CompletePasskeyRegistrationHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var errors = CompletePasskeyRegistrationValidator.Validate(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var name = PasskeyRules.NormalizeName(request!.Name) ?? PasskeyRules.DefaultName;
        var created = await handler.HandleAsync(
            new CompletePasskeyRegistrationCommand(
                userId, request.ChallengeId!.Value, name, request.Credential!, ClientInfo.From(http)),
            cancellationToken);

        return created is null
            ? IdentityProblems.PasskeyRegistrationFailed()
            : TypedResults.Created($"/api/v1/identity/passkeys/{created.Id}", created);
    }
}
