using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Refresh;

/// <summary>
/// O desafio de uso único para recuperar um refresh cuja resposta se perdeu. <c>Challenge</c> é nulo quando o token
/// ainda não girou (o pedido nem chegou ao servidor): basta um refresh comum. <c>FamilyId</c> (32 hexadecimais) entra na
/// mensagem que o aparelho assina.
/// </summary>
internal sealed record RefreshChallengeResponse(
    string? Challenge,
    string? FamilyId,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int ExpiresIn);

internal enum RefreshChallengeStatus
{
    /// <summary>Desafio emitido: o token girou e pode ser recuperado.</summary>
    Issued,

    /// <summary>O token não girou: nada a recuperar, o cliente faz um refresh comum.</summary>
    NotNeeded,

    /// <summary>Outra aba girou este token agora há pouco (tolerância de giro simultâneo): tentar de novo em instantes.</summary>
    Conflict,

    /// <summary>Token desconhecido, vencido, revogado ou reutilizado sem direito à recuperação (a família foi revogada).</summary>
    Unauthenticated,
}

internal sealed record RefreshChallengeResult(
    RefreshChallengeStatus Status,
    string? Challenge = null,
    Guid FamilyId = default,
    int ExpiresInSeconds = 0);

/// <summary>
/// Primeiro passo da recuperação. Apresentar aqui um token já girado equivale a apresentá-lo ao refresh: sem direito à
/// recuperação (fora da janela, sem chave, sucessor já usado, já recuperado) a família é revogada do mesmo jeito. O
/// desafio só é emitido se tudo o que não depende da assinatura já vale; a assinatura é conferida no refresh.
/// </summary>
internal sealed class RefreshChallengeHandler(
    IdentityDbContext db,
    RefreshRecoveryService recovery,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    public async Task<RefreshChallengeResult> HandleAsync(RefreshCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var policy = options.Value.Refresh;
        var hash = SecretTokens.Hash(command.Secret);
        if (hash is null)
        {
            return new RefreshChallengeResult(RefreshChallengeStatus.Unauthenticated);
        }

        var token = await db.RefreshTokens.SingleOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);
        if (token is null)
        {
            return new RefreshChallengeResult(RefreshChallengeStatus.Unauthenticated);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await FamilyLock.AcquireAsync(db, token.FamilyId, cancellationToken);
        await db.Entry(token).ReloadAsync(cancellationToken);
        if (db.Entry(token).State == EntityState.Detached)
        {
            return new RefreshChallengeResult(RefreshChallengeStatus.Unauthenticated);
        }

        var now = time.GetUtcNow();
        switch (token.Evaluate(now, policy.ReuseGrace))
        {
            case RefreshDecision.Valid:
                return new RefreshChallengeResult(RefreshChallengeStatus.NotNeeded);
            case RefreshDecision.Conflict:
                return new RefreshChallengeResult(RefreshChallengeStatus.Conflict);
            case RefreshDecision.Expired:
                return new RefreshChallengeResult(RefreshChallengeStatus.Unauthenticated);
        }

        var candidate = await recovery.CheckAsync(token, now, policy, cancellationToken);
        if (candidate.Denial is { } denial)
        {
            await recovery.RevokeFamilyForReuseAsync(token, now, command.Client, denial, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new RefreshChallengeResult(RefreshChallengeStatus.Unauthenticated);
        }

        var challenge = await recovery.IssueChallengeAsync(token, now, policy, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new RefreshChallengeResult(
            RefreshChallengeStatus.Issued, challenge, token.FamilyId, (int)policy.ChallengeLifetime.TotalSeconds);
    }
}

internal static class RefreshChallengeEndpoint
{
    public static void MapRefreshChallenge(this IEndpointRouteBuilder group) =>
        group.MapPost("/auth/refresh/challenge", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Refresh)
            .Produces<RefreshChallengeResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        RefreshChallengeHandler handler,
        AuthCookieWriter cookies,
        CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request))
        {
            return IdentityProblems.MissingClientHeader();
        }

        http.Request.Cookies.TryGetValue(AuthCookieWriter.RefreshCookieName, out var secret);
        var result = await handler.HandleAsync(new RefreshCommand(secret, ClientInfo.From(http)), cancellationToken);

        switch (result.Status)
        {
            case RefreshChallengeStatus.Issued:
                return TypedResults.Ok(new RefreshChallengeResponse(
                    result.Challenge, result.FamilyId.ToString("N"), result.ExpiresInSeconds));
            case RefreshChallengeStatus.NotNeeded:
                return TypedResults.Ok(new RefreshChallengeResponse(null, null, 0));
            case RefreshChallengeStatus.Conflict:
                return IdentityProblems.Conflict();
            default:
                cookies.DeleteRefresh(http.Response);
                return IdentityProblems.Unauthenticated();
        }
    }
}
