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

namespace UniOver.Modules.Identity.Features.ChangePassword;

internal sealed record ChangePasswordRequest(string? CurrentPassword, string? NewPassword);

internal enum ChangePasswordStatus
{
    Changed,
    Unauthenticated,
    InvalidCurrentPassword,
    SamePassword,
    Locked,
}

internal sealed record ChangePasswordResult(ChangePasswordStatus Status, TimeSpan RetryAfter = default);

/// <summary>
/// A própria pessoa confirma a senha atual antes de escolher outra. A sessão em uso continua aberta; todas as outras
/// famílias de refresh são revogadas na mesma transação. Quando houver TOTP, este é o ponto para exigir o segundo fator.
/// </summary>
internal sealed class ChangePasswordHandler(
    IdentityDbContext db,
    PasswordService passwords,
    LoginAuditWriter audit,
    FailedLoginCounter failures,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options,
    UserAccessNotifier? access = null)
{
    public async Task<ChangePasswordResult> HandleAsync(
        Guid userId, Guid sessionId, string currentPassword, string newPassword,
        ClientInfo client, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        // Duas trocas simultâneas da mesma conta não podem validar a mesma senha antiga.
        await db.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({userId.ToString("N")}, 42))", cancellationToken);

        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == userId, cancellationToken);
        if (user is null || user.IsBlocked || !await db.RefreshTokens.AnyAsync(
                t => t.UserId == userId && t.FamilyId == sessionId && t.RevokedAt == null, cancellationToken))
        {
            return new ChangePasswordResult(ChangePasswordStatus.Unauthenticated);
        }

        if (user.IsLockedOut(now))
        {
            audit.Add(userId, AuditEvents.LoginLocked, client, "password-change");
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new ChangePasswordResult(ChangePasswordStatus.Locked, user.RemainingLockout(now));
        }

        if (passwords.Verify(user, currentPassword) == PasswordCheck.Failed)
        {
            await failures.RegisterAsync(userId, now, options.Value.Lockout, cancellationToken);
            audit.Add(userId, AuditEvents.PasswordChangeFailed, client);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new ChangePasswordResult(ChangePasswordStatus.InvalidCurrentPassword);
        }

        if (string.Equals(currentPassword, newPassword, StringComparison.Ordinal))
        {
            return new ChangePasswordResult(ChangePasswordStatus.SamePassword);
        }

        user.RegisterSuccess();
        user.ReplacePasswordHash(passwords.Hash(newPassword));

        await db.RefreshTokens.Where(t => t.UserId == userId && t.FamilyId != sessionId && t.RevokedAt == null)
            .ExecuteUpdateAsync(setters => setters.SetProperty(t => t.RevokedAt, now)
                .SetProperty(t => t.RevokedReason, RevokeReasons.PasswordChanged), cancellationToken);
        await db.StepUpConfirmations.Where(c => c.UserId == userId).ExecuteDeleteAsync(cancellationToken);

        audit.Add(userId, AuditEvents.PasswordChanged, client);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        // As outras sessões acabaram (a que trocou a senha segue): o canal direto delas fecha na hora.
        if (access is not null)
        {
            await access.NotifyAsync(new UserAccessChange(userId, UserAccessChangeKind.SessionsEnded, sessionId), cancellationToken);
        }

        return new ChangePasswordResult(ChangePasswordStatus.Changed);
    }
}

internal static class ChangePasswordEndpoint
{
    public static void MapChangePassword(this IEndpointRouteBuilder group) =>
        group.MapPost("/me/password", HandleAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http, ICurrentUser current, ChangePasswordRequest? request,
        ChangePasswordHandler handler, IOptions<IdentityModuleOptions> options,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrEmpty(request?.CurrentPassword) || request.CurrentPassword.Length > PasswordPolicy.MaximumLength)
        {
            errors["currentPassword"] = ["Informe a senha atual."];
        }

        var newPasswordProblems = PasswordPolicy.Validate(request?.NewPassword, options.Value.MinPasswordLength);
        if (newPasswordProblems.Count > 0)
        {
            errors["newPassword"] =
            [
                newPasswordProblems.Contains("password-too-short")
                    ? $"A senha precisa ter ao menos {options.Value.MinPasswordLength} caracteres."
                    : "Informe uma senha nova válida.",
            ];
        }

        if (errors.Count > 0) return ProblemDetailsExtensions.ValidationProblem(errors);

        var result = await handler.HandleAsync(userId, sessionId, request!.CurrentPassword!, request.NewPassword!,
            ClientInfo.From(http), cancellationToken);
        return result.Status switch
        {
            ChangePasswordStatus.Changed => TypedResults.NoContent(),
            ChangePasswordStatus.Unauthenticated => IdentityProblems.Unauthenticated(),
            ChangePasswordStatus.InvalidCurrentPassword => IdentityProblems.InvalidPassword(),
            ChangePasswordStatus.Locked => IdentityProblems.Locked(http.Response, result.RetryAfter),
            ChangePasswordStatus.SamePassword => ProblemDetailsExtensions.ValidationProblem(
                new Dictionary<string, string[]> { ["newPassword"] = ["Escolha uma senha diferente da atual."] }),
            _ => throw new InvalidOperationException("Resultado de troca de senha desconhecido."),
        };
    }
}
