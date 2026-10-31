using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;
using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Features.QrLogin;

internal static class PollQrLoginEndpoint
{
    /// <summary>
    /// Anônima: a credencial é o segredo de consulta (32 bytes aleatórios, só o hash no banco), no corpo e nunca na URL. Um
    /// segredo que não existe, que venceu ou que já recebeu a sessão respondem igual (<c>expired</c>).
    /// </summary>
    public static void MapPollQrLogin(this IEndpointRouteBuilder group) =>
        group.MapPost("/auth/qr/poll", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.QrPoll)
            .Produces<PollQrLoginResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        PollQrLoginRequest? request,
        PollQrLoginHandler handler,
        AuthCookieWriter cookies,
        CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request))
        {
            return IdentityProblems.MissingClientHeader();
        }

        if (SecretTokens.Hash(request?.Secret) is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["secret"] = ["Informe o segredo da consulta."],
            });
        }

        // Sem rastro em cache: a resposta pode trazer um token de acesso.
        http.Response.Headers.CacheControl = "no-store";
        var result = await handler.HandleAsync(new PollQrLoginCommand(request!.Secret!, ClientInfo.From(http)), cancellationToken);
        if (result.Status != QrLoginStatuses.Approved)
        {
            return TypedResults.Ok(new PollQrLoginResponse(result.Status));
        }

        cookies.AppendRefresh(http.Response, result.RefreshSecret!, result.RefreshMaxAge);
        return TypedResults.Ok(new PollQrLoginResponse(result.Status, result.AccessToken, result.ExpiresInSeconds));
    }
}

internal sealed record PollQrLoginCommand(string Secret, ClientInfo Client);

internal sealed record PollQrLoginResult(
    string Status,
    string? AccessToken = null,
    int ExpiresInSeconds = 0,
    string? RefreshSecret = null,
    TimeSpan RefreshMaxAge = default);

/// <summary>
/// A consulta do computador. Quando o celular já confirmou, a sessão sai daqui UMA vez, do mesmo jeito que no login
/// (uma família de refresh nova, com o IP e o aparelho do COMPUTADOR), e o pedido deixa de valer.
/// </summary>
internal sealed class PollQrLoginHandler(
    IdentityDbContext db,
    AccessTokenIssuer tokens,
    LoginAuditWriter audit,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    private static PollQrLoginResult Of(string status) => new(status);

    public async Task<PollQrLoginResult> HandleAsync(PollQrLoginCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var hash = SecretTokens.Hash(command.Secret);
        if (hash is null)
        {
            return Of(QrLoginStatuses.Expired);
        }

        var request = await db.QrLoginRequests.AsNoTracking()
            .SingleOrDefaultAsync(r => r.PollSecretHash == hash, cancellationToken);
        if (request is null)
        {
            return Of(QrLoginStatuses.Expired);
        }

        var now = time.GetUtcNow();
        switch (request.Evaluate(now))
        {
            case QrLoginState.Pending:
                return Of(QrLoginStatuses.Pending);
            case QrLoginState.Denied:
                return Of(QrLoginStatuses.Denied);
            case QrLoginState.Expired:
                return Of(QrLoginStatuses.Expired);
        }

        // Confirmado e ainda sem sessão entregue. A conta pode ter sido revogada entre a confirmação e agora.
        var settings = options.Value;
        var userId = request.ApprovedBy!.Value;
        var account = await db.Users
            .Where(u => u.Id == userId)
            .Select(u => new { u.Role, u.DisabledAt })
            .SingleOrDefaultAsync(cancellationToken);
        if (account is null || account.DisabledAt is not null)
        {
            return Of(QrLoginStatuses.Denied);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        // Quem consome é quem consegue marcar a linha: dois pedidos ao mesmo tempo (duas abas com o mesmo segredo, ou o
        // reenvio de uma resposta perdida) nunca recebem duas sessões. O perdedor vê "expirou".
        var requestId = request.Id;
        var claimed = await db.QrLoginRequests
            .Where(r => r.Id == requestId && r.ConsumedAt == null && r.ApprovedAt != null && r.DeniedAt == null && r.ExpiresAt > now)
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.ConsumedAt, now), cancellationToken);
        if (claimed != 1)
        {
            return Of(QrLoginStatuses.Expired);
        }

        var familyId = IdGenerator.NewId();
        var (secret, secretHash) = SecretTokens.Generate();
        var expiresAt = settings.Refresh.ExpiryFor(now, now);
        db.RefreshTokens.Add(RefreshToken.Create(
            userId, familyId, secretHash, now, expiresAt, command.Client.Ip, command.Client.UserAgent));
        DeviceKeyRegistration.Add(db, familyId, userId, command.Client, now);
        audit.Add(userId, AuditEvents.QrLoginSucceeded, command.Client, request.Id.ToString("N"));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        var access = tokens.Issue(userId, familyId, account.Role, UniOverAuth.ApiAudience, settings.AccessLifetime, now);
        return new PollQrLoginResult(
            QrLoginStatuses.Approved,
            access.Value,
            (int)settings.AccessLifetime.TotalSeconds,
            secret,
            expiresAt - now);
    }
}
