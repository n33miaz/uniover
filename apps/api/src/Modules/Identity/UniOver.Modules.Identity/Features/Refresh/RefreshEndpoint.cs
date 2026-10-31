using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Refresh;

internal static class RefreshEndpoint
{
    public static void MapRefresh(this IEndpointRouteBuilder group) =>
        group.MapPost("/auth/refresh", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Refresh)
            .Produces<RefreshResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        RefreshHandler handler,
        AuthCookieWriter cookies,
        CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request))
        {
            return IdentityProblems.MissingClientHeader();
        }

        http.Request.Cookies.TryGetValue(AuthCookieWriter.RefreshCookieName, out var secret);
        var result = await handler.HandleAsync(new RefreshCommand(secret, ClientInfo.From(http)), cancellationToken);

        switch (result.Status)
        {
            case RefreshStatus.Succeeded:
                cookies.AppendRefresh(http.Response, result.RefreshSecret!, result.RefreshMaxAge);
                return TypedResults.Ok(new RefreshResponse(result.AccessToken!, result.ExpiresInSeconds));
            case RefreshStatus.Conflict:
                return IdentityProblems.Conflict();
            case RefreshStatus.Paused:
                cookies.DeleteRefresh(http.Response);
                return IdentityProblems.GuestPausedUnauthenticated();
            default:
                // O cookie não serve mais a ninguém: limpa para o navegador não reenviá-lo.
                cookies.DeleteRefresh(http.Response);
                return IdentityProblems.Unauthenticated();
        }
    }
}
