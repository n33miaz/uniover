using System.Globalization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.SendText;

internal sealed record SendTextRequest(string? Text);

internal sealed record SendTextCommand(TvCommandOrigin Origin, string Text);

internal static class SendTextValidator
{
    public const int MaxLength = 200;

    /// <summary>
    /// As mesmas regras do contrato com o agente (1 a 200 caracteres Unicode, sem caracteres de controle): um texto
    /// que a API deixasse passar e o contrato recusasse viraria erro 500 em vez de 400.
    /// </summary>
    public static Dictionary<string, string[]> Validate(SendTextRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        var text = request?.Text;

        if (string.IsNullOrEmpty(text))
        {
            errors["text"] = ["Informe o texto a digitar."];
        }
        else if (text.EnumerateRunes().Count() > MaxLength)
        {
            errors["text"] = [$"O texto deve ter no máximo {MaxLength} caracteres."];
        }
        else if (text.Any(IsControl))
        {
            errors["text"] = ["O texto não pode ter quebra de linha nem outros caracteres de controle."];
        }

        return errors;
    }

    private static bool IsControl(char c) => c <= '\u001f' || (c >= '\u007f' && c <= '\u009f');
}

internal sealed class SendTextHandler(TvCommandRunner runner)
{
    public Task<TvSendOutcome> HandleAsync(SendTextCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // O que se digita pode ser uma senha: na auditoria entra só o tamanho, nunca o conteúdo.
        var detail = string.Create(CultureInfo.InvariantCulture, $"length={command.Text.EnumerateRunes().Count()}");
        return runner.RunAsync(
            command.Origin, TvCommandNames.Text, detail, TvMessages.Text(command.Text), waitForReply: true, cancellationToken);
    }
}

internal static class SendTextEndpoint
{
    public static void MapSendText(this IEndpointRouteBuilder group) =>
        group.MapPost("/text", HandleAsync).RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCommandOk>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        SendTextRequest request,
        ICurrentUser current,
        HttpContext http,
        SendTextHandler handler,
        CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var errors = SendTextValidator.Validate(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        return TvProblems.ToResult(await handler.HandleAsync(new SendTextCommand(origin, request.Text!), cancellationToken));
    }
}
