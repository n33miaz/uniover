using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Pair;

/// <summary>O corpo do pedido: sem <c>Code</c> a TV mostra o código na tela; com ele o pareamento é concluído.</summary>
internal sealed record PairRequest(string? Code);

/// <summary>Como terminou o pedido: o agente é antigo demais para o pareamento, ou o resultado da entrega.</summary>
internal sealed record PairResult(bool Unsupported, TvSendOutcome? Outcome);

internal static partial class PairValidator
{
    /// <summary>O código que a Android TV mostra: 6 caracteres hexadecimais (o mesmo formato do contrato com o agente).</summary>
    [GeneratedRegex(@"^[0-9A-Fa-f]{6}\z", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 100)]
    private static partial Regex CodePattern();

    public static Dictionary<string, string[]> Validate(PairRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request?.Code is { } code && !CodePattern().IsMatch(code))
        {
            errors["code"] = ["O código tem 6 caracteres (0-9 e A-F), como aparece na TV."];
        }

        return errors;
    }
}

/// <summary>
/// Parear a Android TV de novo, em dois passos e só por toque do dono: pedir o código (a TV o mostra na tela) e entregar o
/// código digitado. O agente nunca inicia isto sozinho. O código é segredo de vida curta: vai só no corpo da mensagem ao
/// agente, nunca para a auditoria, o registro nem a resposta.
/// </summary>
internal sealed class PairHandler(TvCommandRunner runner, IAgentPresenceReader presence)
{
    /// <summary>O agente responde logo (confirma o código na tela, ou conclui com a TV): é a espera de um comando comum, folgada.</summary>
    public static readonly TimeSpan ReplyTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Os dois passos aparecem na trilha com um detalhe fixo, nunca com o código.</summary>
    public const string StartDetail = "step=start";

    public const string FinishDetail = "step=finish";

    public async Task<PairResult> HandleAsync(
        TvCommandOrigin origin, TvTarget tv, string? code, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(origin);
        ArgumentNullException.ThrowIfNull(tv);

        // Agente que se apresentou sem a capacidade não recebe nada: a tela explica que o computador precisa atualizar.
        if (presence.Get(tv.AgentSlug) is { } info && !info.Capabilities.Contains(TvCapabilities.PairV1, StringComparer.Ordinal))
        {
            return new PairResult(true, null);
        }

        var outcome = await runner.RunAsync(
            origin,
            TvCommandNames.Pair,
            code is null ? StartDetail : FinishDetail,
            TvMessages.Pair(code),
            waitForReply: true,
            cancellationToken,
            ReplyTimeout);
        return new PairResult(false, outcome);
    }
}

internal static class PairEndpoint
{
    public const string UnsupportedType = "pair-unsupported";

    public static void MapPair(this IEndpointRouteBuilder group) =>
        group.MapPost("/pair", HandleAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCommandOk>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        PairRequest? request,
        ICurrentUser current,
        HttpContext http,
        ITvCurrentSelection selection,
        PairHandler handler,
        CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var errors = PairValidator.Validate(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(origin, selection.Current, request?.Code, cancellationToken);
        if (result.Unsupported)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "O computador da TV precisa ser atualizado para parear pelo app.",
                type: ProblemDetailsExtensions.TypeBase + UnsupportedType);
        }

        return TvProblems.ToResult(result.Outcome!);
    }
}
