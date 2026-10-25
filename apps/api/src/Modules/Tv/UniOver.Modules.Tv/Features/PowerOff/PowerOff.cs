using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.PowerOff;

/// <summary>
/// Corpo opcional do pedido de desligar. <paramref name="Mode"/> <c>safe</c> pede o desligamento com leitura (o agente só
/// aperta <c>POWER</c> com a TV lida como ligada e confirma o resultado); sem o corpo vale o comportamento de antes, que
/// manda a tecla <c>POWER</c>.
/// </summary>
internal sealed record PowerOffRequest(string? Mode);

internal sealed record PowerOffCommand(TvCommandOrigin Origin, bool Safe);

/// <summary>Desfechos que a tela recebe num 200: o que de fato aconteceu com a TV.</summary>
internal static class PowerOffOutcomes
{
    /// <summary>A tecla <c>POWER</c> foi entregue; o agente (antigo) não confirma o resultado.</summary>
    public const string Sent = "sent";

    /// <summary>O agente leu a TV ligada, apertou <c>POWER</c> uma vez e confirmou que ela desligou.</summary>
    public const string Off = "off";

    /// <summary>O agente leu a TV desligada e não enviou tecla nenhuma.</summary>
    public const string AlreadyOff = "already_off";
}

/// <summary>Resposta de um pedido de desligar entregue: como a de qualquer comando, mais o desfecho.</summary>
internal sealed record TvPowerOffOk(
    bool Ok,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int LatencyMs,
    string Outcome);

internal static class PowerOffValidator
{
    public const string SafeMode = "safe";

    public static bool TryParse(PowerOffRequest? request, out bool safe)
    {
        safe = false;
        var mode = request?.Mode?.Trim();
        if (string.IsNullOrEmpty(mode))
        {
            return true;
        }

        safe = string.Equals(mode, SafeMode, StringComparison.Ordinal);
        return safe;
    }
}

internal sealed class PowerOffHandler(
    TvCommandRunner runner, IAgentPresenceReader presence, IOptions<TvModuleOptions> options)
{
    /// <summary>
    /// Resultado do pedido: o que o agente respondeu e o desfecho para a tela. <c>already_off</c> chega do agente como
    /// falha de comando (ele não apertou nada), mas para a tela é um resultado, e não um erro.
    /// </summary>
    public async Task<(TvSendOutcome Send, string Outcome)> HandleAsync(PowerOffCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // O desligamento com leitura só vai a quem declarou saber fazê-lo: um agente que não o conhece recusaria o tipo de
        // mensagem, e a tecla sozinha (o comportamento de antes) é o que ele entende.
        var target = await runner.ResolveTargetAsync(cancellationToken);
        var safe = command.Safe && SupportsSafePowerOff(target.AgentSlug);

        // Com "power" a TV sai da rede e só o infravermelho a religa (ela não tem botão físico). O dono decidiu que
        // desligar não pede a passkey: o freio é o limite de comandos e a trilha, que guarda este comando com nome próprio.
        var send = safe
            ? await runner.RunAsync(
                command.Origin, TvCommandNames.PowerOff, "POWER", TvMessages.PowerOff(), waitForReply: true, cancellationToken, options.Value.PowerOffTimeout)
            : await runner.RunAsync(
                command.Origin, TvCommandNames.PowerOff, "POWER", TvMessages.Key(TvKeyV3BodyKey.Power), waitForReply: true, cancellationToken);

        if (!safe)
        {
            return (send, PowerOffOutcomes.Sent);
        }

        return send is { Status: TvSendStatus.CommandFailed, ErrorCode: TvAgentCodes.AlreadyOff }
            ? (send, PowerOffOutcomes.AlreadyOff)
            : (send, PowerOffOutcomes.Off);
    }

    private bool SupportsSafePowerOff(string agentSlug) =>
        !string.IsNullOrWhiteSpace(agentSlug)
        && presence.Get(agentSlug)?.Capabilities.Contains(TvCapabilities.PowerOffV1, StringComparer.Ordinal) == true;
}

internal static class PowerOffEndpoint
{
    public static void MapPowerOff(this IEndpointRouteBuilder group) =>
        group.MapPost("/power/off", HandleAsync).RequireAuthorization(TvAuth.Power)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvPowerOffOk>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        HttpContext http,
        PowerOffHandler handler,
        CancellationToken cancellationToken,
        PowerOffRequest? request = null)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        if (!PowerOffValidator.TryParse(request, out var safe))
        {
            return ProblemDetailsExtensions.ValidationProblem(
                new Dictionary<string, string[]> { ["mode"] = ["O modo deve ser omitido ou ser safe."] });
        }

        var (send, outcome) = await handler.HandleAsync(new PowerOffCommand(origin, safe), cancellationToken);
        return send.IsDelivered || outcome == PowerOffOutcomes.AlreadyOff
            ? TypedResults.Ok(new TvPowerOffOk(true, (int)send.Latency.TotalMilliseconds, outcome))
            : TvProblems.Fail(send);
    }
}
