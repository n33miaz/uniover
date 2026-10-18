using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.BeginPasskeyRegistration;

internal static class BeginPasskeyRegistrationEndpoint
{
    public static void MapBeginPasskeyRegistration(this IEndpointRouteBuilder group) =>
        group.MapPost("/passkeys/registration/options", HandleAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Login);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        ICurrentUser current,
        BeginPasskeyRegistrationRequest? request,
        BeginPasskeyRegistrationHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        if (string.IsNullOrEmpty(request?.Password) || request.Password.Length > PasswordPolicy.MaximumLength)
        {
            return ProblemDetailsExtensions.ValidationProblem(
                new Dictionary<string, string[]> { ["password"] = ["Informe a senha."] });
        }

        var result = await handler.HandleAsync(
            new BeginPasskeyRegistrationCommand(userId, request.Password, ClientInfo.From(http)), cancellationToken);

        return result.Status switch
        {
            BeginPasskeyRegistrationStatus.Succeeded => TypedResults.Ok(result.Response),
            BeginPasskeyRegistrationStatus.Locked => IdentityProblems.Locked(http.Response, result.RetryAfter),
            BeginPasskeyRegistrationStatus.InvalidPassword => IdentityProblems.InvalidPassword(),
            _ => IdentityProblems.Unauthenticated(),
        };
    }
}
