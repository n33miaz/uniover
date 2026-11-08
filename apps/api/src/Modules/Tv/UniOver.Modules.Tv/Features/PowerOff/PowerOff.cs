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
/// aperta <c>POWER</c> com a TV lida como ligada e confirma o resultado). Se a capacidade sumiu, nada é enviado. Sem o
/// corpo o desligar com leitura vale do mesmo jeito para o agente que o declara; só o agente antigo (capacidades
/// conhecidas, sem ele) recebe a tecla <c>POWER</c> avulsa, e sem capacidade conhecida nada é enviado.
/// </summary>
internal sealed record PowerOffRequest(string? Mode);

/// <param name="RequireSafe">
/// Só vale o desligamento com leitura; se o agente não o conhece, nada é enviado. Os atalhos do iPhone pedem assim: a tecla
/// <c>POWER</c> às cegas é um interruptor e, com a TV já desligada, poderia ligá-la.
/// </param>
internal sealed record PowerOffCommand(TvCommandOrigin Origin, bool Safe, bool RequireSafe = false);

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
    /// <summary>Código de falha de quem exigiu o desligamento com leitura (<see cref="PowerOffCommand.RequireSafe"/>) e o agente não o conhece.</summary>
    public const string UnsafePowerOffCode = "power_off_unsafe";

    /// <summary>
    /// Resultado do pedido: o que o agente respondeu e o desfecho para a tela. <c>already_off</c> chega do agente como
    /// falha de comando (ele não apertou nada), mas para a tela é um resultado, e não um erro.
    /// </summary>
    public async Task<(TvSendOutcome Send, string Outcome)> HandleAsync(PowerOffCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // O desligamento com leitura vale para todo agente que o declara, mesmo que o corpo do pedido venha vazio (um app
        // antigo em cache, uma chamada direta): a tecla POWER avulsa é um interruptor e ligaria uma TV desligada.
        var target = await runner.ResolveTargetAsync(cancellationToken);
        var capabilities = KnownCapabilities(target.AgentSlug);
        if (capabilities is null && !string.IsNullOrWhiteSpace(target.AgentSlug))
        {
            // Sem capacidade conhecida (a API acabou de subir e o hello do agente ainda não chegou) não dá para saber se existe
            // o desligar seguro: mandar POWER agora seria um palpite. A tela diz "reconectando" e o pedido pode ser repetido.
            var unknown = TvSendOutcome.Failed(
                TvSendStatus.AgentOffline,
                presence.Get(target.AgentSlug) is { Connected: true } ? TvCommandRunner.AgentReconnectingCode : AgentErrors.OfflineCode);
            await runner.RecordAsync(command.Origin, TvCommandNames.PowerOff, "POWER", unknown);
            return (unknown, PowerOffOutcomes.Sent);
        }

        var safe = capabilities?.Contains(TvCapabilities.PowerOffV1, StringComparer.Ordinal) == true;
        if (command.RequireSafe && !safe)
        {
            return (TvSendOutcome.Failed(TvSendStatus.CommandFailed, UnsafePowerOffCode), PowerOffOutcomes.Sent);
        }

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

    /// <summary>
    /// As capacidades que o agente declarou no <c>hello</c>, ou nulo se ainda não se sabe (sem
    /// presença, ou presença sem <c>hello</c>, que é a lista vazia). Um agente que já falou sempre declara alguma capacidade.
    /// </summary>
    private IReadOnlyList<string>? KnownCapabilities(string agentSlug) =>
        !string.IsNullOrWhiteSpace(agentSlug) && presence.Get(agentSlug)?.Capabilities is { Count: > 0 } known ? known : null;
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

        var (send, outcome) = await handler.HandleAsync(new PowerOffCommand(origin, safe, RequireSafe: safe), cancellationToken);
        return send.IsDelivered || outcome == PowerOffOutcomes.AlreadyOff
            ? TypedResults.Ok(new TvPowerOffOk(true, (int)send.Latency.TotalMilliseconds, outcome))
            : TvProblems.Fail(send);
    }
}
