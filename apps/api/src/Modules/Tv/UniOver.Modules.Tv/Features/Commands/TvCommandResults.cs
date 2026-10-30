using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Commands;

/// <summary>Resposta de um comando entregue: o agente respondeu <c>ok</c> e quanto tempo levou.</summary>
internal sealed record TvCommandOk(bool Ok, [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.Strict)] int LatencyMs)
{
    public static TvCommandOk From(TvSendOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(outcome);
        return new TvCommandOk(true, (int)outcome.Latency.TotalMilliseconds);
    }
}

/// <summary>Como cada falha de comando vira <c>ProblemDetails</c> (tipos estáveis que a tela reconhece).</summary>
internal static class TvProblems
{
    public const string AgentOfflineType = "agent-offline";
    public const string AgentTimeoutType = "agent-timeout";
    public const string CommandFailedType = "command-failed";
    public const string AgentNotConfiguredType = "agent-not-configured";
    public const string ShortcutDisabledType = "shortcut-disabled";
    public const string InternalType = "internal-error";

    /// <summary>Status, tipo e título de uma falha. Separado de <see cref="Fail"/> para ser testado sem HTTP.</summary>
    public static (int Status, string Type, string Title) Describe(TvSendStatus status) => status switch
    {
        TvSendStatus.AgentOffline => (StatusCodes.Status503ServiceUnavailable, AgentOfflineType, "O agente da TV não está conectado."),
        TvSendStatus.AgentTimeout => (StatusCodes.Status504GatewayTimeout, AgentTimeoutType, "O agente da TV não respondeu a tempo."),
        TvSendStatus.CommandFailed => (StatusCodes.Status502BadGateway, CommandFailedType, "A TV não executou o comando."),
        TvSendStatus.NotConfigured => (StatusCodes.Status503ServiceUnavailable, AgentNotConfiguredType, "Nenhum agente está configurado para controlar a TV."),
        _ => (StatusCodes.Status500InternalServerError, InternalType, "Não foi possível montar o comando."),
    };

    public static IResult Fail(TvSendOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(outcome);

        var (status, type, title) = Describe(outcome.Status);

        // O código do agente (ex.: TV_UNREACHABLE) ajuda a tela e o log; o texto livre dele não sai da API.
        Dictionary<string, object?>? extensions = outcome.Status == TvSendStatus.CommandFailed && outcome.ErrorCode is { Length: > 0 } code
            ? new Dictionary<string, object?> { ["agentError"] = code }
            : null;
        if (outcome.Status == TvSendStatus.AgentOffline && outcome.ErrorCode == TvCommandRunner.AgentReconnectingCode)
        {
            // O PC caiu há pouco e ainda conta como conectado: a tela diz "reconectando", não "desligado".
            extensions = new Dictionary<string, object?> { ["reconnecting"] = true };
        }

        return Results.Problem(
            statusCode: status, title: title, type: ProblemDetailsExtensions.TypeBase + type, extensions: extensions);
    }

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    /// <summary>200 com o resultado do comando ou o problema correspondente.</summary>
    public static IResult ToResult(TvSendOutcome outcome) =>
        outcome.IsDelivered ? TypedResults.Ok(TvCommandOk.From(outcome)) : Fail(outcome);
}

/// <summary>Ponte entre a requisição HTTP e os handlers, que só recebem valores simples.</summary>
internal static class TvHttp
{
    public static ClientInfo ClientOf(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        // O IP já vem corrigido pelos forwarded headers quando ligados; o User-Agent é texto do cliente e é truncado na gravação.
        return new ClientInfo(
            http.Connection.RemoteIpAddress?.ToString(),
            http.Request.Headers.UserAgent.ToString() is { Length: > 0 } agent ? agent : null);
    }

    public static TvCommandOrigin? OriginOf(ICurrentUser current, HttpContext http) =>
        current.UserId is { } userId ? new TvCommandOrigin(userId, ClientOf(http)) : null;
}
