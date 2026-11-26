using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// O pedido do canal: a oferta SDP e o que o app quer levar por ele. <paramref name="Scopes"/> são <c>pc</c> e/ou <c>tv</c> (sem
/// eles, só o PC, como sempre foi) e <paramref name="TvId"/> a TV (sem ela, a única ou a padrão que a pessoa vê). A API só concede o
/// que a pessoa pode agora: o que não puder cai sem erro e a resposta diz o que ficou.
/// </summary>
internal sealed record PcRtcOfferRequest(string? Sdp, string[]? Scopes = null, Guid? TvId = null, Guid? ParentSessionId = null);

/// <summary>O TOTAL de segundos com tecla ou mouse que o app mandou por este canal desde que ele abriu (a parte "direta" da paridade).</summary>
internal sealed record PcRtcUsageRequest(int? TotalSeconds);

internal sealed record PcRtcCandidateRequest(string? Candidate, string? SdpMid, int? SdpMLineIndex);

/// <summary>A resposta da oferta: o SDP do agente (com a impressão digital DTLS dele), o token que a primeira mensagem do canal apresenta e os escopos que o canal ficou com (o que a pessoa pode agora).</summary>
internal sealed record PcRtcOfferResponse(Guid SessionId, string Sdp, string Token, int ExpiresInSeconds, string[] Scopes);

/// <summary>Os limites do que o app pode pedir: o que a API deixaria passar e o contrato recusasse viraria 500 em vez de 400.</summary>
internal static class PcRtcValidator
{
    public const int MaxSdp = 16_384;
    public const int MaxCandidate = 512;

    public static Dictionary<string, string[]> Offer(PcRtcOfferRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        var sdp = request?.Sdp;
        if (string.IsNullOrWhiteSpace(sdp))
        {
            errors["sdp"] = ["Informe a oferta do canal."];
        }
        else if (sdp.Length > MaxSdp)
        {
            errors["sdp"] = [$"A oferta deve ter no máximo {MaxSdp} caracteres."];
        }
        else if (!sdp.StartsWith("v=0", StringComparison.Ordinal)
            || !sdp.Contains("a=fingerprint:", StringComparison.Ordinal)
            || !sdp.Contains("m=application", StringComparison.Ordinal))
        {
            // Só um canal de dados com a impressão digital DTLS: é ela que prende o par à sinalização autenticada.
            errors["sdp"] = ["A oferta precisa ser de um canal de dados, com a impressão digital DTLS."];
        }

        if (request?.Scopes is { } scopes
            && (scopes.Length is 0 or > 2 || scopes.Distinct(StringComparer.Ordinal).Count() != scopes.Length
                || scopes.Any(name => name is not (PcRtcScopeNames.Pc or PcRtcScopeNames.Tv or PcRtcScopeNames.Screen))
                || (scopes.Contains(PcRtcScopeNames.Screen) && scopes.Length != 1)))
        {
            errors["scopes"] = ["Use pc e/ou tv, sem repetir, ou apenas screen."];
        }

        var isScreen = PcRtcScopeNames.Parse(request?.Scopes) == PcRtcScopes.Screen;
        if (isScreen && (request?.ParentSessionId is null || request.ParentSessionId == Guid.Empty)
            || !isScreen && request?.ParentSessionId is not null)
        {
            errors["parentSessionId"] = ["Informe a sessão de controle do PC somente para a tela."];
        }

        if (request?.TvId == Guid.Empty || isScreen && request?.TvId is not null)
        {
            errors["tvId"] = ["Informe a TV."];
        }

        return errors;
    }

    public static Dictionary<string, string[]> Candidate(PcRtcCandidateRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        var candidate = request?.Candidate;
        if (string.IsNullOrWhiteSpace(candidate) || candidate.Length > MaxCandidate
            || !candidate.StartsWith("candidate:", StringComparison.Ordinal) || candidate.Any(char.IsControl))
        {
            errors["candidate"] = ["Informe um candidato ICE válido."];
        }

        if (request?.SdpMid is { Length: > 32 })
        {
            errors["sdpMid"] = ["Use até 32 caracteres."];
        }

        if (request?.SdpMLineIndex is < 0 or > 8)
        {
            errors["sdpMLineIndex"] = ["Use de 0 a 8."];
        }

        return errors;
    }
}

internal static class PcRtcEndpoints
{
    /// <summary>
    /// O canal direto é do aparelho, não só do PC: quem tem o controle do PC (<c>module:pc</c>) ou o da TV (<c>tv:control</c>) pode
    /// abri-lo. O que ele leva é decidido na oferta, escopo a escopo (ver <see cref="PcRtcHandler"/>), e a rota nunca concede o que a
    /// permissão da pessoa não cobre. O caminho `/pc/rtc` é o do primeiro uso do canal e se mantém: o app e o agente já o conhecem.
    /// </summary>
    public const string Policy = "devices:direct-channel";

    public static void ConfigurePolicy(AuthorizationPolicyBuilder policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        policy.RequireAnyPermission(AccessPermissions.PcModule, AccessPermissions.TvControl);
    }

    private static readonly string ModulePolicy = Policy;

    /// <summary>
    /// A rota do uso do canal não pede permissão de módulo: para um convidado, conferir a permissão lê o banco quando o cache esfria, e o
    /// app manda o uso a cada minuto. Quem autoriza é a sessão do canal, em memória, que a oferta já autorizou: ela existe, é da mesma
    /// conta do token e não venceu (ver <see cref="PcRtcSessions.AcceptsUsage"/>). O papel (dono ou convidado) vem da claim do token,
    /// também sem banco.
    /// </summary>
    public const string UsagePolicy = "devices:direct-channel-usage";

    public static void ConfigureUsagePolicy(AuthorizationPolicyBuilder policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        policy.RequireAccountRole(AccountRoles.Owner, AccountRoles.Guest).AddRequirements(new PcRtcUsageRequirement());
    }

    /// <summary>Mapeia as rotas do canal direto em <c>/api/v1/pc/rtc</c>. Todas pedem <c>module:pc</c> ou <c>tv:control</c> e o balde de limite próprio.</summary>
    public static void MapPcRtc(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/api/v1/pc/rtc");

        group.MapPost("/offer", OfferAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcRtc)
            .Produces<PcRtcOfferResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

        group.MapPost("/{sessionId:guid}/candidates", CandidateAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcRtc)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status410Gone)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        // O uso do canal (só a contagem de segundos, nada do que foi digitado): memória só, sem banco e sem o agente.
        group.MapPost("/{sessionId:guid}/usage", Usage)
            .RequireAuthorization(UsagePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcRtc)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        group.MapPost("/{sessionId:guid}/close", CloseAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcRtc)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
    }

    private static async Task<IResult> OfferAsync(
        PcRtcOfferRequest? request,
        ICurrentUser current,
        HttpContext http,
        PcRtcHandler handler,
        TimeProvider time,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcRtcValidator.Offer(request);
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.OfferAsync(
                userId,
                string.Equals(AccountRoles.Of(http.User), AccountRoles.Owner, StringComparison.Ordinal),
                current.SessionId,
                RemainingAccess(http.User, time),
                request!,
                ClientInfo.From(http),
                cancellationToken);
    }

    /// <summary>O que resta do token de acesso (claim <c>exp</c>); sem a claim, o teto.</summary>
    internal static TimeSpan RemainingAccess(ClaimsPrincipal user, TimeProvider time)
    {
        var claim = user.FindFirst("exp")?.Value;
        return long.TryParse(claim, NumberStyles.None, CultureInfo.InvariantCulture, out var expires)
            ? DateTimeOffset.FromUnixTimeSeconds(expires) - time.GetUtcNow()
            : PcRtcHandler.MaxLifetime;
    }

    private static async Task<IResult> CandidateAsync(
        Guid sessionId, PcRtcCandidateRequest? request, ICurrentUser current, PcRtcHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcRtcValidator.Candidate(request);
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.CandidateAsync(userId, sessionId, request!, cancellationToken, current.SessionId);
    }

    private static async Task<IResult> CloseAsync(
        Guid sessionId, ICurrentUser current, HttpContext http, PcRtcHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        return await handler.CloseAsync(userId, sessionId, ClientInfo.From(http), cancellationToken, current.SessionId);
    }

    /// <summary>
    /// O app conta os segundos em que mandou tecla ou mouse pelo canal (a API não os vê: o canal é direto) e manda aqui o TOTAL da
    /// sessão a cada minuto e ao fechar. Repetir o total não soma de novo, e o aceito nunca passa do tempo que o canal está aberto. A política só deixa passar a sessão da própria pessoa, viva ou fechada há pouco (a última contagem chega depois do
    /// fechamento).
    /// </summary>
    private static IResult Usage(
        Guid sessionId, PcRtcUsageRequest? request, ICurrentUser current, PcRtcSessions sessions, AgentParity parity)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        if (request?.TotalSeconds is not { } total || total < 1 || total > PcRtcSessions.MaxUsageTotalSeconds)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["totalSeconds"] = [$"Mande o total de 1 a {PcRtcSessions.MaxUsageTotalSeconds} segundos."],
            });
        }

        // A política já conferiu a sessão; ela pode ter saído da memória entre a política e aqui.
        if (sessions.RecordUsage(sessionId, userId, total) is not { } usage)
        {
            return TypedResults.NotFound();
        }

        parity.OnDirectUse(usage.AgentSlug, usage.Added);
        return TypedResults.NoContent();
    }
}

/// <summary>A sessão do canal na rota do uso pode receber o uso de quem pede (ver <see cref="PcRtcEndpoints.UsagePolicy"/>).</summary>
internal sealed class PcRtcUsageRequirement : IAuthorizationRequirement
{
}

/// <summary>Autoriza o uso do canal só pela memória: a sessão da rota, viva ou fechada há pouco, é desta conta. Nenhuma consulta.</summary>
internal sealed class PcRtcUsageAuthorizer(PcRtcSessions sessions) : AuthorizationHandler<PcRtcUsageRequirement>
{
    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, PcRtcUsageRequirement requirement)
    {
        if (context.Resource is HttpContext http
            && Guid.TryParse(http.GetRouteValue("sessionId") as string, out var sessionId)
            && Guid.TryParse(context.User.FindFirst(UniOverAuth.SubjectClaim)?.Value, out var userId)
            && sessions.AcceptsUsage(sessionId, userId))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}
