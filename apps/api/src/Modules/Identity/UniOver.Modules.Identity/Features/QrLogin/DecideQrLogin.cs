using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.QrLogin;

/// <summary>
/// O que o celular faz com o pedido: ver (<c>info</c>), confirmar (<c>approve</c>) e recusar (<c>deny</c>). As três rotas
/// exigem uma sessão de conta ativa (dono ou convidado); o limite é por conta.
/// </summary>
internal static class DecideQrLoginEndpoints
{
    public static void MapQrLoginDecisions(this IEndpointRouteBuilder group)
    {
        group.MapPost("/auth/qr/info", InfoAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.QrDecide)
            .Produces<QrLoginInfoResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status410Gone)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        group.MapPost("/auth/qr/approve", ApproveAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.QrDecide)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status410Gone)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        group.MapPost("/auth/qr/deny", DenyAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.QrDecide)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status410Gone)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult? InvalidCode(string? code) =>
        QrLoginCodes.Hash(code) is null
            ? ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["code"] = ["Abra o QR da tela do computador de novo."],
            })
            : null;

    private static async Task<IResult> InfoAsync(
        HttpContext http,
        ICurrentUser current,
        QrLoginCodeRequest? request,
        QrLoginDecisionHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
        {
            return IdentityProblems.Unauthenticated();
        }

        if (InvalidCode(request?.Code) is { } invalid)
        {
            return invalid;
        }

        http.Response.Headers.CacheControl = "no-store";
        if (!await handler.SessionIsAliveAsync(userId, sessionId, cancellationToken))
        {
            return IdentityProblems.Unauthenticated();
        }

        var info = await handler.InfoAsync(userId, sessionId, request!.Code!, ClientInfo.From(http), cancellationToken);
        return info is null ? IdentityProblems.QrInvalid() : TypedResults.Ok(info);
    }

    private static async Task<IResult> ApproveAsync(
        HttpContext http,
        ICurrentUser current,
        ApproveQrLoginRequest? request,
        QrLoginDecisionHandler handler,
        CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request))
        {
            return IdentityProblems.MissingClientHeader();
        }

        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
        {
            return IdentityProblems.Unauthenticated();
        }

        if (InvalidCode(request?.Code) is { } invalid)
        {
            return invalid;
        }

        var result = await handler.ApproveAsync(
            new ApproveQrLoginCommand(userId, sessionId, request!.Code!, request.Password, ClientInfo.From(http)),
            cancellationToken);

        http.Response.Headers.CacheControl = "no-store";
        switch (result.Status)
        {
            case ApproveQrLoginStatus.Approved:
                return TypedResults.NoContent();
            case ApproveQrLoginStatus.StepUpRequired:
                return IdentityProblems.StepUpRequired(StepUpActions.QrLoginApprove);
            case ApproveQrLoginStatus.PasswordRequired:
                return IdentityProblems.QrReauthRequired();
            case ApproveQrLoginStatus.InvalidPassword:
                return IdentityProblems.InvalidPassword();
            case ApproveQrLoginStatus.Locked:
                return IdentityProblems.Locked(http.Response, result.RetryAfter);
            case ApproveQrLoginStatus.Unauthenticated:
                return IdentityProblems.Unauthenticated();
            default:
                return IdentityProblems.QrInvalid();
        }
    }

    private static async Task<IResult> DenyAsync(
        HttpContext http,
        ICurrentUser current,
        QrLoginCodeRequest? request,
        QrLoginDecisionHandler handler,
        CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request))
        {
            return IdentityProblems.MissingClientHeader();
        }

        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
        {
            return IdentityProblems.Unauthenticated();
        }

        if (InvalidCode(request?.Code) is { } invalid)
        {
            return invalid;
        }

        if (!await handler.SessionIsAliveAsync(userId, sessionId, cancellationToken))
        {
            return IdentityProblems.Unauthenticated();
        }

        var denied = await handler.DenyAsync(userId, request!.Code!, ClientInfo.From(http), cancellationToken);
        return denied ? TypedResults.NoContent() : IdentityProblems.QrInvalid();
    }
}

internal enum ApproveQrLoginStatus
{
    Approved,

    /// <summary>Pedido desconhecido, vencido, já decidido ou já usado.</summary>
    Invalid,
    StepUpRequired,
    PasswordRequired,
    InvalidPassword,
    Locked,
    Unauthenticated,
}

internal sealed record ApproveQrLoginCommand(Guid UserId, Guid SessionId, string Code, string? Password, ClientInfo Client);

internal sealed record ApproveQrLoginResult(ApproveQrLoginStatus Status, TimeSpan RetryAfter = default);

/// <summary>
/// Confirmar a entrada de um computador dá uma sessão inteira da conta a quem está diante da tela dele; por isso a
/// confirmação pede uma prova nova (e o QR sozinho, que qualquer um vê, não vale como prova):
/// com passkey, a confirmação da ação <see cref="StepUpActions.QrLoginApprove"/> nesta sessão (gasta ao confirmar, então cada
/// entrada pede um toque novo); sem passkey, ou a sessão do celular é recente (acabou de entrar) ou a senha vai junto
/// (errar conta para o mesmo bloqueio do login, como no cadastro de passkey).
/// </summary>
internal sealed class QrLoginDecisionHandler(
    IdentityDbContext db,
    PasswordService passwords,
    LoginAuditWriter audit,
    FailedLoginCounter failures,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    /// <summary>
    /// A sessão do celular ainda não foi encerrada. O JWT de acesso vale por alguns minutos depois do logout, e ver, confirmar
    /// ou recusar um QR não deve valer junto com ele.
    /// </summary>
    public Task<bool> SessionIsAliveAsync(Guid userId, Guid sessionId, CancellationToken cancellationToken = default) =>
        db.RefreshTokens.AnyAsync(
            t => t.FamilyId == sessionId && t.UserId == userId && t.RevokedAt == null, cancellationToken);

    public async Task<QrLoginInfoResponse?> InfoAsync(
        Guid userId, Guid sessionId, string code, ClientInfo client, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        var request = await FindOpenAsync(code, now, cancellationToken);
        if (request is null)
        {
            return null;
        }

        var verification = await VerificationForAsync(userId, sessionId, now, cancellationToken);
        var sameNetwork = request.RequesterIp is not null && string.Equals(request.RequesterIp, client.Ip, StringComparison.Ordinal);
        return new QrLoginInfoResponse(request.RequesterUserAgent, sameNetwork, request.ExpiresAt, verification);
    }

    public async Task<ApproveQrLoginResult> ApproveAsync(ApproveQrLoginCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = time.GetUtcNow();
        var userId = command.UserId;
        var sessionId = command.SessionId;

        // O JWT de acesso sobrevive ao logout por alguns minutos; a confirmação não.
        var sessionAlive = await SessionIsAliveAsync(userId, sessionId, cancellationToken);
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == userId, cancellationToken);
        if (!sessionAlive || user is null || user.IsBlocked)
        {
            return new ApproveQrLoginResult(ApproveQrLoginStatus.Unauthenticated);
        }

        var request = await FindOpenAsync(command.Code, now, cancellationToken);
        if (request is null)
        {
            return new ApproveQrLoginResult(ApproveQrLoginStatus.Invalid);
        }

        var verification = await VerificationForAsync(userId, sessionId, now, cancellationToken);
        var passwordChecked = false;
        switch (verification)
        {
            case QrLoginVerifications.Passkey:
                var confirmed = await db.StepUpConfirmations.AnyAsync(
                    c => c.UserId == userId && c.SessionFamilyId == sessionId && c.Action == StepUpActions.QrLoginApprove && c.ExpiresAt > now,
                    cancellationToken);
                if (!confirmed)
                {
                    return new ApproveQrLoginResult(ApproveQrLoginStatus.StepUpRequired);
                }

                break;

            case QrLoginVerifications.Password:
                if (string.IsNullOrEmpty(command.Password) || command.Password.Length > PasswordPolicy.MaximumLength)
                {
                    return new ApproveQrLoginResult(ApproveQrLoginStatus.PasswordRequired);
                }

                if (user.IsLockedOut(now))
                {
                    audit.Add(user.Id, AuditEvents.LoginLocked, command.Client, "qr-login");
                    await db.SaveChangesAsync(cancellationToken);
                    return new ApproveQrLoginResult(ApproveQrLoginStatus.Locked, user.RemainingLockout(now));
                }

                if (passwords.Verify(user, command.Password) == PasswordCheck.Failed)
                {
                    await failures.RegisterAsync(user.Id, now, options.Value.Lockout, cancellationToken);
                    audit.Add(user.Id, AuditEvents.LoginFailed, command.Client, "qr-login");
                    await db.SaveChangesAsync(cancellationToken);
                    return new ApproveQrLoginResult(ApproveQrLoginStatus.InvalidPassword);
                }

                passwordChecked = true;
                break;
        }

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        // Só uma decisão vence: confirmar e recusar (ou duas confirmações) ao mesmo tempo não passam as duas. Confirmado, o
        // computador tem uma janela curta para recolher a sessão, mesmo que o QR estivesse quase vencendo.
        var requestId = request.Id;
        var approver = command.Client;
        var claimed = await db.QrLoginRequests
            .Where(r => r.Id == requestId && r.ApprovedAt == null && r.DeniedAt == null && r.ConsumedAt == null && r.ExpiresAt > now)
            .ExecuteUpdateAsync(
                s => s
                    .SetProperty(r => r.ApprovedAt, now)
                    .SetProperty(r => r.ApprovedBy, userId)
                    .SetProperty(r => r.ApproverIp, AuditText.Truncate(approver.Ip, AuditText.IpMax))
                    .SetProperty(r => r.ApproverUserAgent, AuditText.Truncate(approver.UserAgent, AuditText.UserAgentMax))
                    .SetProperty(r => r.ExpiresAt, now + QrLoginRequest.CollectWindow),
                cancellationToken);
        if (claimed != 1)
        {
            return new ApproveQrLoginResult(ApproveQrLoginStatus.Invalid);
        }

        // A confirmação da passkey vale uma entrada só. Gastar é a operação que decide (e não a leitura lá de cima): duas
        // confirmações de QRs diferentes ao mesmo tempo, com um único toque, só passam uma; a outra desfaz a sua.
        if (verification == QrLoginVerifications.Passkey)
        {
            var spent = await db.StepUpConfirmations
                .Where(c => c.UserId == userId && c.SessionFamilyId == sessionId && c.Action == StepUpActions.QrLoginApprove && c.ExpiresAt > now)
                .ExecuteDeleteAsync(cancellationToken);
            if (spent == 0)
            {
                await transaction.RollbackAsync(cancellationToken);
                return new ApproveQrLoginResult(ApproveQrLoginStatus.StepUpRequired);
            }
        }

        if (passwordChecked)
        {
            user.RegisterSuccess();
        }

        audit.Add(userId, AuditEvents.QrLoginApproved, command.Client, request.Id.ToString("N"));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new ApproveQrLoginResult(ApproveQrLoginStatus.Approved);
    }

    public async Task<bool> DenyAsync(Guid userId, string code, ClientInfo client, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        var request = await FindOpenAsync(code, now, cancellationToken);
        if (request is null)
        {
            return false;
        }

        var requestId = request.Id;
        var denied = await db.QrLoginRequests
            .Where(r => r.Id == requestId && r.ApprovedAt == null && r.DeniedAt == null && r.ConsumedAt == null && r.ExpiresAt > now)
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.DeniedAt, now), cancellationToken);
        if (denied != 1)
        {
            return false;
        }

        audit.Add(userId, AuditEvents.QrLoginDenied, client, request.Id.ToString("N"));
        await db.SaveChangesAsync(cancellationToken);
        return true;
    }

    private async Task<QrLoginRequest?> FindOpenAsync(string code, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var hash = QrLoginCodes.Hash(code);
        if (hash is null)
        {
            return null;
        }

        var request = await db.QrLoginRequests.AsNoTracking().SingleOrDefaultAsync(r => r.CodeHash == hash, cancellationToken);
        return request is not null && request.IsOpenAt(now) ? request : null;
    }

    /// <summary>
    /// A prova que a conta precisa dar: passkey se tem alguma; senão nada se a sessão do celular começou há pouco, ou a senha.
    /// A idade vem da data do primeiro refresh da família (a sessão), como o teto absoluto do refresh.
    /// </summary>
    private async Task<string> VerificationForAsync(Guid userId, Guid sessionId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (await db.Passkeys.AnyAsync(p => p.UserId == userId, cancellationToken))
        {
            return QrLoginVerifications.Passkey;
        }

        var startedAt = await db.RefreshTokens
            .Where(t => t.FamilyId == sessionId && t.UserId == userId)
            .MinAsync(t => (DateTimeOffset?)t.CreatedAt, cancellationToken);
        return startedAt is { } started && now - started <= options.Value.QrRecentLogin
            ? QrLoginVerifications.None
            : QrLoginVerifications.Password;
    }
}
