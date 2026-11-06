using System.Collections.Concurrent;
using System.Globalization;
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

/// <summary>
/// O corpo do pedido: sem <c>Code</c> nem <c>Cancel</c> a TV mostra o código na tela; com <c>Code</c> o pareamento é
/// concluído; com <c>Cancel</c> o app fechou a folha e o agente larga o pareamento que esperava o código.
/// </summary>
internal sealed record PairRequest(string? Code, bool? Cancel = null)
{
    public bool IsCancel => Cancel == true;
}

/// <summary>
/// Como terminou o pedido: o agente é antigo demais para o pareamento, o pedido do código veio cedo demais
/// (<paramref name="RetryAfter"/>), ou o resultado da entrega.
/// </summary>
internal sealed record PairResult(bool Unsupported, TvSendOutcome? Outcome, TimeSpan? RetryAfter = null);

/// <summary>Quem pediu e para qual TV (o handler recebe os dois juntos).</summary>
internal readonly record struct PairTarget(TvCommandOrigin Origin, TvTarget Tv);

internal static partial class PairValidator
{
    /// <summary>
    /// O código que a Android TV mostra: 6 caracteres hexadecimais (o mesmo formato do contrato com o agente). <c>\z</c> e não
    /// <c>$</c>: o <c>$</c> do .NET aceitaria uma quebra de linha no fim.
    /// </summary>
    [GeneratedRegex(@"^[0-9A-Fa-f]{6}\z", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 100)]
    private static partial Regex CodePattern();

    public static Dictionary<string, string[]> Validate(PairRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request?.Code is { } code && !CodePattern().IsMatch(code))
        {
            errors["code"] = ["O código tem 6 caracteres (0-9 e A-F), como aparece na TV."];
        }
        else if (request is { IsCancel: true, Code: not null })
        {
            errors["cancel"] = ["Cancelar e entregar o código não vão juntos."];
        }

        return errors;
    }
}

/// <summary>
/// O intervalo mínimo entre dois pedidos de código na mesma TV: cada um troca o código na tela dela, então uma sequência
/// deles (ou uma sessão roubada) a deixaria piscando. Em memória e por TV; só o pedido do código conta, nunca o
/// cancelamento nem a entrega do código.
/// </summary>
internal sealed class PairThrottle(TimeProvider time)
{
    public static readonly TimeSpan MinimumInterval = TimeSpan.FromSeconds(10);

    private readonly ConcurrentDictionary<string, DateTimeOffset> _last = new(StringComparer.Ordinal);

    /// <summary>Reserva a vez de <paramref name="key"/>; se veio cedo demais, diz quanto falta.</summary>
    public TimeSpan? TryAcquire(string key)
    {
        var now = time.GetUtcNow();
        TimeSpan? wait = null;
        _last.AddOrUpdate(
            key,
            now,
            (_, last) =>
            {
                if (now - last < MinimumInterval)
                {
                    wait = MinimumInterval - (now - last);
                    return last;
                }

                return now;
            });
        return wait;
    }
}

/// <summary>
/// Parear a Android TV de novo, em passos e só por toque do dono: pedir o código (a TV o mostra na tela), entregar o
/// código digitado e cancelar (a folha fechou). O agente nunca inicia isto sozinho. O código é segredo de vida curta: vai
/// só no corpo da mensagem ao agente, nunca para a auditoria, o registro nem a resposta.
/// </summary>
internal sealed class PairHandler(TvCommandRunner runner, IAgentPresenceReader presence, PairThrottle throttle)
{
    /// <summary>
    /// O agente responde cada passo em até 20 s (15 s com a TV, mais até 5 s esperando a vez de outro pedido) e reabre a
    /// sessão à parte, depois de responder: 30 s deixam folga de sobra.
    /// </summary>
    public static readonly TimeSpan ReplyTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Os passos aparecem na trilha com um detalhe fixo, nunca com o código.</summary>
    public const string StartDetail = "step=start";

    public const string FinishDetail = "step=finish";

    public const string CancelDetail = "step=cancel";

    public async Task<PairResult> HandleAsync(PairTarget target, string? code, bool cancel, CancellationToken cancellationToken)
    {
        var (origin, tv) = target;
        ArgumentNullException.ThrowIfNull(origin);
        ArgumentNullException.ThrowIfNull(tv);

        // Agente que se apresentou sem a capacidade não recebe nada: a tela explica que o computador precisa atualizar.
        if (presence.Get(tv.AgentSlug) is { } info && !info.Capabilities.Contains(TvCapabilities.PairV1, StringComparer.Ordinal))
        {
            return new PairResult(true, null);
        }

        var isStart = code is null && !cancel;
        if (isStart && throttle.TryAcquire(tv.Id == Guid.Empty ? tv.AgentSlug : tv.Id.ToString("N", CultureInfo.InvariantCulture)) is { } wait)
        {
            return new PairResult(false, null, wait);
        }

        var outcome = await runner.RunAsync(
            origin,
            TvCommandNames.Pair,
            cancel ? CancelDetail : isStart ? StartDetail : FinishDetail,
            TvMessages.Pair(code, cancel),
            waitForReply: true,
            cancellationToken,
            ReplyTimeout);
        return new PairResult(false, outcome);
    }
}

internal static class PairEndpoint
{
    public const string UnsupportedType = "pair-unsupported";
    public const string TooSoonType = "pair-too-soon";

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

        var result = await handler.HandleAsync(
            new PairTarget(origin, selection.Current), request?.Code, request?.IsCancel == true, cancellationToken);
        if (result.RetryAfter is { } retry)
        {
            http.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retry.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
            return Results.Problem(
                statusCode: StatusCodes.Status429TooManyRequests,
                title: "Espere alguns segundos antes de pedir outro código.",
                type: ProblemDetailsExtensions.TypeBase + TooSoonType);
        }

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
