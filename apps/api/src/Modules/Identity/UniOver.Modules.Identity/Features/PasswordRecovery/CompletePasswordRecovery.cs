using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.PasswordRecovery;

internal sealed record CompletePasswordRecoveryRequest(
    string? Token, string? NewPassword, string? TotpCode = null, string? RecoveryCode = null);

internal enum CompletePasswordRecoveryStatus { Changed, InvalidToken, FactorRequired, FactorInvalid, FactorUnavailable, Locked }

internal sealed class CompletePasswordRecoveryHandler(
    IdentityDbContext db, PasswordService passwords, SecondFactorVerifier secondFactor,
    FailedLoginCounter failures, LoginAuditWriter audit, TimeProvider time,
    IOptions<IdentityModuleOptions> options, UserAccessNotifier? access = null)
{
    public async Task<CompletePasswordRecoveryStatus> HandleAsync(
        string token, string newPassword, string? totpCode, string? recoveryCode,
        ClientInfo client, CancellationToken cancellationToken)
    {
        var hash = SecretTokens.Hash(token);
        if (hash is null) return CompletePasswordRecoveryStatus.InvalidToken;
        var now = time.GetUtcNow();
        var candidate = await db.PasswordResetTokens.AsNoTracking()
            .SingleOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);
        if (candidate is null || !candidate.CanUse(now)) return CompletePasswordRecoveryStatus.InvalidToken;

        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({candidate.UserId.ToString("N")}, 45))", cancellationToken);
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == candidate.UserId, cancellationToken);
        if (user is null || user.IsBlocked) return CompletePasswordRecoveryStatus.InvalidToken;
        if (user.IsLockedOut(now)) return CompletePasswordRecoveryStatus.Locked;

        var factor = await secondFactor.VerifyAsync(user.Id, totpCode, recoveryCode, now, cancellationToken);
        if (factor == SecondFactorStatus.Required) return CompletePasswordRecoveryStatus.FactorRequired;
        if (factor == SecondFactorStatus.Unavailable) return CompletePasswordRecoveryStatus.FactorUnavailable;
        if (factor == SecondFactorStatus.Invalid)
        {
            await failures.RegisterAsync(user.Id, now, options.Value.Lockout, cancellationToken);
            audit.Add(null, AuditEvents.PasswordRecoveryFailed, client, AuditAboutAccount.Detail(user.Id));
            await db.SaveChangesAsync(cancellationToken);
            await tx.CommitAsync(cancellationToken);
            return CompletePasswordRecoveryStatus.FactorInvalid;
        }

        // Consumo condicional no banco: duas requisições simultâneas com o mesmo link não trocam a senha duas vezes.
        var claimed = await db.PasswordResetTokens
            .Where(t => t.Id == candidate.Id && t.UsedAt == null && t.ExpiresAt > now)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.UsedAt, now), cancellationToken);
        if (claimed != 1) return CompletePasswordRecoveryStatus.InvalidToken;

        user.ReplacePasswordHash(passwords.Hash(newPassword));
        user.RegisterSuccess();
        await db.RefreshTokens.Where(t => t.UserId == user.Id && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedAt, now)
                .SetProperty(t => t.RevokedReason, RevokeReasons.PasswordReset), cancellationToken);
        await db.StepUpConfirmations.Where(c => c.UserId == user.Id).ExecuteDeleteAsync(cancellationToken);
        await db.PasswordResetTokens.Where(t => t.UserId == user.Id && t.Id != candidate.Id && t.UsedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.UsedAt, now), cancellationToken);
        audit.Add(user.Id, AuditEvents.PasswordRecovered, client);
        await db.SaveChangesAsync(cancellationToken);
        await tx.CommitAsync(cancellationToken);

        // Todas as sessões acabaram: o canal direto do controle do PC fecha na hora.
        if (access is not null)
        {
            await access.NotifyAsync(new UserAccessChange(user.Id, UserAccessChangeKind.SessionsEnded));
        }

        return CompletePasswordRecoveryStatus.Changed;
    }
}

internal static class CompletePasswordRecoveryEndpoint
{
    public static void MapCompletePasswordRecovery(this IEndpointRouteBuilder group) =>
        group.MapPost("/auth/password/reset", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces(StatusCodes.Status204NoContent);

    private static async Task<IResult> HandleAsync(
        HttpContext http, CompletePasswordRecoveryRequest? request,
        CompletePasswordRecoveryHandler handler, IOptions<IdentityModuleOptions> options,
        CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request)) return IdentityProblems.MissingClientHeader();
        var errors = new Dictionary<string, string[]>();
        if (SecretTokens.Hash(request?.Token) is null) errors["token"] = ["Link inválido ou vencido."];
        var passwordProblems = PasswordPolicy.Validate(request?.NewPassword, options.Value.MinPasswordLength);
        if (passwordProblems.Count > 0) errors["newPassword"] = ["Informe uma senha nova válida."];
        if (errors.Count > 0) return ProblemDetailsExtensions.ValidationProblem(errors);

        var status = await handler.HandleAsync(request!.Token!, request.NewPassword!, request.TotpCode,
            request.RecoveryCode, ClientInfo.From(http), cancellationToken);
        return status switch
        {
            CompletePasswordRecoveryStatus.Changed => TypedResults.NoContent(),
            CompletePasswordRecoveryStatus.FactorRequired => Results.Problem(statusCode: 428,
                title: "Informe o código do autenticador ou um código de recuperação.",
                type: ProblemDetailsExtensions.TypeBase + "second-factor-required"),
            CompletePasswordRecoveryStatus.FactorInvalid => Results.Problem(statusCode: 403,
                title: "Código de confirmação inválido."),
            CompletePasswordRecoveryStatus.FactorUnavailable => Results.Problem(statusCode: 503,
                title: "Não foi possível conferir o segundo fator agora."),
            CompletePasswordRecoveryStatus.Locked => Results.Problem(statusCode: 429,
                title: "Conta temporariamente bloqueada."),
            _ => Results.Problem(statusCode: 400, title: "Link inválido ou vencido."),
        };
    }
}
