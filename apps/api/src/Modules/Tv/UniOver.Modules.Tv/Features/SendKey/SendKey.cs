using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.SendKey;

/// <param name="Key">Nome da tecla no contrato (ex.: <c>VOLUME_UP</c>, <c>NUM_0</c>).</param>
/// <param name="Direction"><c>SHORT</c> (padrão), <c>START_LONG</c> ou <c>END_LONG</c>.</param>
internal sealed record SendKeyRequest(string? Key, string? Direction);

internal sealed record SendKeyCommand(
    TvCommandOrigin Origin, string KeyName, TvKeyV2BodyKey Key, TvKeyV2BodyDirection? Direction);

internal static class SendKeyValidator
{
    public const string PowerKey = "POWER";

    /// <summary>
    /// A tecla e a direção precisam existir no contrato gerado. <c>POWER</c> não passa por aqui: desligar tem rota
    /// própria, para que toda ordem de desligar fique na trilha com o nome certo.
    /// </summary>
    public static Dictionary<string, string[]> Validate(SendKeyRequest? request, out SendKeyParsed? parsed)
    {
        parsed = null;
        var errors = new Dictionary<string, string[]>();

        var keyName = request?.Key?.Trim();
        TvKeyV2BodyKey key = default;
        if (string.IsNullOrEmpty(keyName) || !TvMessages.Keys.TryGetValue(keyName, out key))
        {
            errors["key"] = ["Informe uma tecla válida (ex.: VOLUME_UP)."];
        }
        else if (string.Equals(keyName, PowerKey, StringComparison.Ordinal))
        {
            errors["key"] = ["Para desligar a TV use a ação de desligar."];
        }

        TvKeyV2BodyDirection? direction = null;
        if (request?.Direction is { } directionName)
        {
            if (TvMessages.Directions.TryGetValue(directionName.Trim(), out var value))
            {
                direction = value;
            }
            else
            {
                errors["direction"] = ["A direção deve ser SHORT, START_LONG ou END_LONG."];
            }
        }

        if (errors.Count == 0)
        {
            parsed = new SendKeyParsed(keyName!, key, direction);
        }

        return errors;
    }
}

internal sealed record SendKeyParsed(string KeyName, TvKeyV2BodyKey Key, TvKeyV2BodyDirection? Direction);

internal sealed class SendKeyHandler(TvCommandRunner runner)
{
    public Task<TvSendOutcome> HandleAsync(SendKeyCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var detail = command.Direction is { } direction
            ? $"{command.KeyName}/{TvMessages.Directions.First(d => d.Value == direction).Key}"
            : command.KeyName;
        return runner.RunAsync(
            command.Origin, TvCommandNames.Key, detail, TvMessages.Key(command.Key, command.Direction), waitForReply: true, cancellationToken);
    }
}

internal static class SendKeyEndpoint
{
    public static void MapSendKey(this IEndpointRouteBuilder group) =>
        group.MapPost("/keys", HandleAsync).RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCommandOk>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        SendKeyRequest request,
        ICurrentUser current,
        HttpContext http,
        SendKeyHandler handler,
        CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var errors = SendKeyValidator.Validate(request, out var parsed);
        if (parsed is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var outcome = await handler.HandleAsync(
            new SendKeyCommand(origin, parsed.KeyName, parsed.Key, parsed.Direction), cancellationToken);
        return TvProblems.ToResult(outcome);
    }
}
