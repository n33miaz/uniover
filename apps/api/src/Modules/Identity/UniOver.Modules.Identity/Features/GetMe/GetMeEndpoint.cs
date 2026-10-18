using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.GetMe;

internal static class GetMeEndpoint
{
    public static void MapGetMe(this IEndpointRouteBuilder group) =>
        group.MapGet("/me", HandleAsync).RequireAuthorization();

    private static async Task<IResult> HandleAsync(ICurrentUser current, GetMeHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var me = await handler.HandleAsync(userId, cancellationToken);
        return me is null ? IdentityProblems.Unauthenticated() : TypedResults.Ok(me);
    }
}
