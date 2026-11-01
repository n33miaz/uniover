using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Wake;

internal sealed record WakeCommand(TvCommandOrigin Origin);

internal sealed class WakeHandler(TvCommandRunner runner)
{
    /// <summary>
    /// Pede ao agente que aqueça a sessão com a TV, sem esperar resposta: a tela chama ao abrir e a cada poucos
    /// minutos enquanto está visível, para a sessão não hibernar com o app aberto.
    /// </summary>
    public Task<TvSendOutcome> HandleAsync(WakeCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        return runner.RunAsync(
            command.Origin,
            TvCommandNames.Wake,
            null,
            TvMessages.Wake(),
            waitForReply: false,
            cancellationToken: cancellationToken,
            auditCommand: false);
    }
}

internal static class WakeEndpoint
{
    public static void MapWake(this IEndpointRouteBuilder group) =>
        group.MapPost("/wake", HandleAsync).RequireAuthorization(TvAuth.Control)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current, HttpContext http, WakeHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var outcome = await handler.HandleAsync(new WakeCommand(origin), cancellationToken);
        return outcome.IsDelivered ? TypedResults.Accepted((string?)null) : TvProblems.Fail(outcome);
    }
}
