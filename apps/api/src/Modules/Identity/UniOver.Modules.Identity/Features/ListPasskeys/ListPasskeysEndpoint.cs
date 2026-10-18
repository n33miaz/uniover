using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.ListPasskeys;

internal static class ListPasskeysEndpoint
{
    public static void MapListPasskeys(this IEndpointRouteBuilder group) =>
        group.MapGet("/passkeys", HandleAsync).RequireAuthorization();

    private static async Task<IResult> HandleAsync(
        ICurrentUser current, ListPasskeysHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        return TypedResults.Ok(await handler.HandleAsync(userId, cancellationToken));
    }
}
