using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Login;

internal static class LoginEndpoint
{
    public static void MapLogin(this IEndpointRouteBuilder group) =>
        group.MapPost("/auth/login", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<LoginResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        LoginRequest? request,
        LoginHandler handler,
        AuthCookieWriter cookies,
        CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request))
        {
            return IdentityProblems.MissingClientHeader();
        }

        var errors = LoginValidator.Validate(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(
            new LoginCommand(request!.Email!, request.Password!, ClientInfo.From(http)), cancellationToken);

        switch (result.Status)
        {
            case LoginStatus.Succeeded:
                cookies.AppendRefresh(http.Response, result.RefreshSecret!, result.RefreshMaxAge);
                return TypedResults.Ok(new LoginResponse(result.AccessToken!, result.ExpiresInSeconds));
            case LoginStatus.Locked:
                return IdentityProblems.Locked(http.Response, result.RetryAfter);
            case LoginStatus.Paused:
                return IdentityProblems.GuestPausedUnauthenticated();
            default:
                return IdentityProblems.InvalidCredentials();
        }
    }
}
