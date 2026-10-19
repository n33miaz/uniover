using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.PowerOff;

internal sealed record PowerOffCommand(TvCommandOrigin Origin);

internal sealed class PowerOffHandler(TvCommandRunner runner)
{
    public Task<TvSendOutcome> HandleAsync(PowerOffCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // Com "power" a TV sai da rede e só o infravermelho a religa (ela não tem botão físico). O dono decidiu que
        // desligar não pede a passkey: o freio é o limite de comandos e a trilha, que guarda este comando com nome próprio.
        return runner.RunAsync(
            command.Origin, TvCommandNames.PowerOff, "POWER", TvMessages.Key(TvKeyV2BodyKey.Power), waitForReply: true, cancellationToken);
    }
}

internal static class PowerOffEndpoint
{
    public static void MapPowerOff(this IEndpointRouteBuilder group) =>
        group.MapPost("/power/off", HandleAsync).RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCommandOk>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current, HttpContext http, PowerOffHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        return TvProblems.ToResult(await handler.HandleAsync(new PowerOffCommand(origin), cancellationToken));
    }
}
