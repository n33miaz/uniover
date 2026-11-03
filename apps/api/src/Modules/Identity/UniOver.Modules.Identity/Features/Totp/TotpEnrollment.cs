using System.Security.Cryptography;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Totp;

internal sealed record StartTotpRequest(string? Password);
internal sealed record StartTotpResponse(string ProvisioningUri, DateTimeOffset ExpiresAt);
internal sealed record ConfirmTotpRequest(string? Code);
internal sealed record ConfirmTotpResponse(IReadOnlyList<string> RecoveryCodes);
internal sealed record TotpStatusResponse(bool Available, bool Active, int RecoveryCodesRemaining);

internal enum TotpEnrollmentStatus { Succeeded, Unauthenticated, InvalidPassword, Locked, StepUpRequired, AlreadyActive, InvalidCode, Unavailable }

internal sealed class TotpEnrollmentHandler(
    IdentityDbContext db, PasswordService passwords, FailedLoginCounter failures,
    TotpKeyProvider key, LoginAuditWriter audit, TimeProvider time, IOptions<IdentityModuleOptions> options)
{
    public async Task<(TotpEnrollmentStatus Status, StartTotpResponse? Response)> StartAsync(
        Guid userId, Guid sessionId, string password, ClientInfo client, CancellationToken cancellationToken)
    {
        if (!key.Available) return (TotpEnrollmentStatus.Unavailable, null);
        var now = time.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({userId.ToString("N")}, 44))", cancellationToken);
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == userId, cancellationToken);
        if (user is null || user.IsBlocked || !await db.RefreshTokens.AnyAsync(
            t => t.UserId == userId && t.FamilyId == sessionId && t.RevokedAt == null, cancellationToken))
            return (TotpEnrollmentStatus.Unauthenticated, null);
        if (await db.TotpFactors.AnyAsync(f => f.UserId == userId && f.ActivatedAt != null, cancellationToken))
            return (TotpEnrollmentStatus.AlreadyActive, null);
        if (user.IsLockedOut(now)) return (TotpEnrollmentStatus.Locked, null);
        if (passwords.Verify(user, password) == PasswordCheck.Failed)
        {
            await failures.RegisterAsync(userId, now, options.Value.Lockout, cancellationToken);
            await tx.CommitAsync(cancellationToken);
            return (TotpEnrollmentStatus.InvalidPassword, null);
        }
        if (user.Role == AccountRoles.Owner && !await db.StepUpConfirmations.AnyAsync(
            c => c.UserId == userId && c.SessionFamilyId == sessionId &&
                c.Action == StepUpActions.FactorManage && c.ExpiresAt > now, cancellationToken))
            return (TotpEnrollmentStatus.StepUpRequired, null);

        var secret = TotpCodes.NewSecret();
        var encrypted = key.Protect(userId, secret);
        await db.TotpFactors.Where(f => f.UserId == userId).ExecuteDeleteAsync(cancellationToken);
        var factor = TotpFactor.Pending(userId, encrypted, now);
        db.TotpFactors.Add(factor);
        await db.SaveChangesAsync(cancellationToken);
        await tx.CommitAsync(cancellationToken);
        var uri = TotpCodes.ProvisioningUri(user.Email, secret);
        CryptographicOperations.ZeroMemory(secret);
        return (TotpEnrollmentStatus.Succeeded, new StartTotpResponse(uri, factor.ExpiresAt));
    }

    public async Task<(TotpEnrollmentStatus Status, ConfirmTotpResponse? Response)> ConfirmAsync(
        Guid userId, Guid sessionId, string code, ClientInfo client, CancellationToken cancellationToken)
    {
        if (!key.Available) return (TotpEnrollmentStatus.Unavailable, null);
        var now = time.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({userId.ToString("N")}, 44))", cancellationToken);
        if (!await db.RefreshTokens.AnyAsync(t => t.UserId == userId && t.FamilyId == sessionId &&
                t.RevokedAt == null, cancellationToken))
            return (TotpEnrollmentStatus.Unauthenticated, null);
        var factor = await db.TotpFactors.SingleOrDefaultAsync(f => f.UserId == userId, cancellationToken);
        if (factor is null || !factor.CanActivate(now)) return (TotpEnrollmentStatus.InvalidCode, null);
        byte[] secret;
        try { secret = key.Unprotect(userId, factor.EncryptedSecret); }
        catch (CryptographicException) { return (TotpEnrollmentStatus.Unavailable, null); }
        var step = TotpCodes.Match(secret, code, now);
        CryptographicOperations.ZeroMemory(secret);
        if (step is null) return (TotpEnrollmentStatus.InvalidCode, null);

        factor.Activate(step.Value, now);
        var plain = new List<string>(10);
        for (var i = 0; i < 10; i++)
        {
            var (value, hash) = RecoveryCodes.Generate();
            plain.Add(value);
            db.AccountRecoveryCodes.Add(AccountRecoveryCode.Create(userId, hash, now));
        }
        audit.Add(userId, AuditEvents.TotpActivated, client);
        await db.SaveChangesAsync(cancellationToken);
        await tx.CommitAsync(cancellationToken);
        return (TotpEnrollmentStatus.Succeeded, new ConfirmTotpResponse(plain));
    }
}

internal static class TotpEnrollmentEndpoint
{
    public static void MapTotpEnrollment(this IEndpointRouteBuilder group)
    {
        group.MapGet("/me/totp", StatusAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .Produces<TotpStatusResponse>();
        group.MapPost("/me/totp/start", StartAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<StartTotpResponse>();
        group.MapPost("/me/totp/confirm", ConfirmAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<ConfirmTotpResponse>();
    }

    private static async Task<IResult> StatusAsync(
        ICurrentUser current, IdentityDbContext db, TotpKeyProvider key, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId) return IdentityProblems.Unauthenticated();
        var active = await db.TotpFactors.AnyAsync(
            f => f.UserId == userId && f.ActivatedAt != null, cancellationToken);
        var remaining = active ? await db.AccountRecoveryCodes.CountAsync(
            c => c.UserId == userId && c.UsedAt == null, cancellationToken) : 0;
        return TypedResults.Ok(new TotpStatusResponse(key.Available, active, remaining));
    }

    private static async Task<IResult> StartAsync(
        HttpContext http, ICurrentUser current, StartTotpRequest? request,
        TotpEnrollmentHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
            return IdentityProblems.Unauthenticated();
        if (string.IsNullOrEmpty(request?.Password) || request.Password.Length > PasswordPolicy.MaximumLength)
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
                { ["password"] = ["Informe a senha atual."] });
        var (status, response) = await handler.StartAsync(userId, sessionId, request.Password, ClientInfo.From(http), cancellationToken);
        http.Response.Headers.CacheControl = "no-store";
        return status switch
        {
            TotpEnrollmentStatus.Succeeded => TypedResults.Ok(response),
            TotpEnrollmentStatus.Unauthenticated => IdentityProblems.Unauthenticated(),
            TotpEnrollmentStatus.InvalidPassword => IdentityProblems.InvalidPassword(),
            TotpEnrollmentStatus.Locked => Results.Problem(statusCode: 429, title: "Conta temporariamente bloqueada."),
            TotpEnrollmentStatus.StepUpRequired => IdentityProblems.StepUpRequired(StepUpActions.FactorManage),
            TotpEnrollmentStatus.AlreadyActive => Results.Problem(statusCode: 409, title: "Autenticador já ativo."),
            _ => Results.Problem(statusCode: 503, title: "Cadastro do autenticador indisponível."),
        };
    }

    private static async Task<IResult> ConfirmAsync(
        HttpContext http, ICurrentUser current, ConfirmTotpRequest? request,
        TotpEnrollmentHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
            return IdentityProblems.Unauthenticated();
        if (request?.Code is not { Length: 6 } || !request.Code.All(char.IsAsciiDigit))
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
                { ["code"] = ["Informe os seis dígitos do aplicativo autenticador."] });
        var (status, response) = await handler.ConfirmAsync(userId, sessionId, request.Code, ClientInfo.From(http), cancellationToken);
        http.Response.Headers.CacheControl = "no-store";
        return status switch
        {
            TotpEnrollmentStatus.Succeeded => TypedResults.Ok(response),
            TotpEnrollmentStatus.Unauthenticated => IdentityProblems.Unauthenticated(),
            TotpEnrollmentStatus.InvalidCode => Results.Problem(statusCode: 400, title: "Código inválido ou cadastro vencido."),
            _ => Results.Problem(statusCode: 503, title: "Cadastro do autenticador indisponível."),
        };
    }
}
