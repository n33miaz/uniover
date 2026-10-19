using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.RefreshShortcuts;

internal sealed record RefreshShortcutsCommand(TvCommandOrigin Origin);

internal sealed class RefreshShortcutsHandler(TvCommandRunner runner)
{
    /// <summary>Pede a lista de apps ao agente; a lista chega depois como mensagem própria e atualiza os atalhos.</summary>
    public Task<TvSendOutcome> HandleAsync(RefreshShortcutsCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        return runner.RunAsync(
            command.Origin, TvCommandNames.AppsRefresh, null, TvMessages.AppsRefresh(), waitForReply: true, cancellationToken);
    }
}

internal static class RefreshShortcutsEndpoint
{
    public static void MapRefreshShortcuts(this IEndpointRouteBuilder group) =>
        group.MapPost("/shortcuts/refresh", HandleAsync).RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCommandOk>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current, HttpContext http, RefreshShortcutsHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        return TvProblems.ToResult(await handler.HandleAsync(new RefreshShortcutsCommand(origin), cancellationToken));
    }
}
