using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.RemovePasskey;

internal static class RemovePasskeyEndpoint
{
    public static void MapRemovePasskey(this IEndpointRouteBuilder group) =>
        group.MapDelete("/passkeys/{id:guid}", HandleAsync)
            .RequireAuthorization(StepUp.Policy(StepUpActions.PasskeyRemove))
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

    private static async Task<IResult> HandleAsync(
        Guid id,
        HttpContext http,
        ICurrentUser current,
        RemovePasskeyHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        return await handler.HandleAsync(userId, id, ClientInfo.From(http), cancellationToken) switch
        {
            RemovePasskeyStatus.Removed => TypedResults.NoContent(),
            RemovePasskeyStatus.LastPasskey => IdentityProblems.LastPasskey(),
            _ => TypedResults.NotFound(),
        };
    }
}
