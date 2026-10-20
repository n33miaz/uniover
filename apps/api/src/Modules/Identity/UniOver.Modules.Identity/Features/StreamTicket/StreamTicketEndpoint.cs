using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.StreamTicket;

internal static class StreamTicketEndpoint
{
    /// <summary>
    /// Exige o JWT no cabeçalho <c>Authorization</c> (nunca na URL) e responde com o cookie de bilhete, que é o
    /// único credencial que a política <c>StreamAccess</c> aceita.
    /// </summary>
    public static void MapStreamTicket(this IEndpointRouteBuilder group) =>
        group.MapPost("/auth/stream-ticket", HandleAsync).RequireAuthorization(IdentityAuth.AccountSessionPolicy)
            .Produces<StreamTicketResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        ICurrentUser current,
        StreamTicketHandler handler,
        AuthCookieWriter cookies,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var result = await handler.HandleAsync(new StreamTicketCommand(userId, sessionId), cancellationToken);
        if (result.Ticket is null)
        {
            return IdentityProblems.Unauthenticated();
        }

        cookies.AppendStream(http.Response, result.Ticket.Value, result.Lifetime);
        return TypedResults.Ok(new StreamTicketResponse((int)result.Lifetime.TotalSeconds));
    }
}
