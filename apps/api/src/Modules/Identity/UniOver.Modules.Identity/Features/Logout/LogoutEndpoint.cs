using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Logout;

internal static class LogoutEndpoint
{
    public static void MapLogout(this IEndpointRouteBuilder group) =>
        group.MapPost("/auth/logout", HandleAsync).RequireAuthorization();

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        ICurrentUser current,
        LogoutHandler handler,
        AuthCookieWriter cookies,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
        {
            return IdentityProblems.Unauthenticated();
        }

        await handler.HandleAsync(new LogoutCommand(userId, sessionId, ClientInfo.From(http)), cancellationToken);

        cookies.DeleteRefresh(http.Response);
        cookies.DeleteStream(http.Response);
        return TypedResults.NoContent();
    }
}
