using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.PasswordRecovery;

internal sealed record RecoverWithCodeRequest(string? RecoveryCode, string? NewPassword);
internal enum RecoverWithCodeStatus { Changed, Unauthenticated, StepUpRequired, InvalidCode, Locked }

/// <summary>Sem e-mail: exige sessão ativa, código previamente emitido e, para o dono, passkey da mesma sessão.</summary>
internal sealed class RecoverWithCodeHandler(
    IdentityDbContext db, PasswordService passwords, FailedLoginCounter failures,
    LoginAuditWriter audit, TimeProvider time, IOptions<IdentityModuleOptions> options)
{
    public async Task<RecoverWithCodeStatus> HandleAsync(
        Guid userId, Guid sessionId, string code, string newPassword, ClientInfo client,
        CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({userId.ToString("N")}, 45))", cancellationToken);
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == userId, cancellationToken);
        if (user is null || user.IsBlocked || !await db.RefreshTokens.AnyAsync(
            t => t.UserId == userId && t.FamilyId == sessionId && t.RevokedAt == null, cancellationToken))
            return RecoverWithCodeStatus.Unauthenticated;
        if (user.IsLockedOut(now)) return RecoverWithCodeStatus.Locked;
        if (!await db.TotpFactors.AnyAsync(f => f.UserId == userId && f.ActivatedAt != null, cancellationToken))
            return RecoverWithCodeStatus.InvalidCode;
        if (user.Role == AccountRoles.Owner && !await db.StepUpConfirmations.AnyAsync(
            c => c.UserId == userId && c.SessionFamilyId == sessionId &&
                c.Action == StepUpActions.PasswordRecovery && c.ExpiresAt > now, cancellationToken))
            return RecoverWithCodeStatus.StepUpRequired;

        var hash = RecoveryCodes.Hash(code);
        var consumed = hash is null ? 0 : await db.AccountRecoveryCodes
            .Where(c => c.UserId == userId && c.CodeHash == hash && c.UsedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.UsedAt, now), cancellationToken);
        if (consumed != 1)
        {
            await failures.RegisterAsync(userId, now, options.Value.Lockout, cancellationToken);
            audit.Add(userId, AuditEvents.PasswordRecoveryFailed, client);
            await db.SaveChangesAsync(cancellationToken);
            await tx.CommitAsync(cancellationToken);
            return RecoverWithCodeStatus.InvalidCode;
        }

        user.ReplacePasswordHash(passwords.Hash(newPassword));
        user.RegisterSuccess();
        await db.RefreshTokens.Where(t => t.UserId == userId && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedAt, now)
                .SetProperty(t => t.RevokedReason, RevokeReasons.PasswordReset), cancellationToken);
        await db.StepUpConfirmations.Where(c => c.UserId == userId).ExecuteDeleteAsync(cancellationToken);
        await db.PasswordResetTokens.Where(t => t.UserId == userId && t.UsedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.UsedAt, now), cancellationToken);
        audit.Add(userId, AuditEvents.PasswordRecovered, client, "recovery-code");
        await db.SaveChangesAsync(cancellationToken);
        await tx.CommitAsync(cancellationToken);
        return RecoverWithCodeStatus.Changed;
    }
}

internal static class RecoverWithCodeEndpoint
{
    public static void MapRecoverWithCode(this IEndpointRouteBuilder group) =>
        group.MapPost("/me/password/recover-with-code", HandleAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces(StatusCodes.Status204NoContent);

    private static async Task<IResult> HandleAsync(
        HttpContext http, ICurrentUser current, RecoverWithCodeRequest? request,
        RecoverWithCodeHandler handler, IOptions<IdentityModuleOptions> options,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
            return IdentityProblems.Unauthenticated();
        var errors = new Dictionary<string, string[]>();
        if (RecoveryCodes.Hash(request?.RecoveryCode) is null)
            errors["recoveryCode"] = ["Informe um código de recuperação válido."];
        if (PasswordPolicy.Validate(request?.NewPassword, options.Value.MinPasswordLength).Count > 0)
            errors["newPassword"] = ["Informe uma senha nova válida."];
        if (errors.Count > 0) return ProblemDetailsExtensions.ValidationProblem(errors);

        var status = await handler.HandleAsync(userId, sessionId, request!.RecoveryCode!, request.NewPassword!,
            ClientInfo.From(http), cancellationToken);
        return status switch
        {
            RecoverWithCodeStatus.Changed => TypedResults.NoContent(),
            RecoverWithCodeStatus.Unauthenticated => IdentityProblems.Unauthenticated(),
            RecoverWithCodeStatus.StepUpRequired => Results.Problem(statusCode: 403,
                title: "Confirme esta ação com a passkey.",
                type: ProblemDetailsExtensions.TypeBase + "factor-step-up-required"),
            RecoverWithCodeStatus.Locked => Results.Problem(statusCode: 429,
                title: "Conta temporariamente bloqueada."),
            _ => Results.Problem(statusCode: 403, title: "Código de recuperação inválido."),
        };
    }
}
