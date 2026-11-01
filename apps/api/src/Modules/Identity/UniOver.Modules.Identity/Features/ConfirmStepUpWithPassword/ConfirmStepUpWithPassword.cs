using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.ConfirmStepUp;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.ConfirmStepUpWithPassword;

internal sealed record ConfirmStepUpWithPasswordRequest(string? Action, string? Password);

internal sealed record ConfirmStepUpWithPasswordCommand(
    Guid UserId,
    Guid SessionId,
    string Action,
    string Password,
    ClientInfo Client);

internal enum ConfirmStepUpWithPasswordStatus
{
    Confirmed,
    Unauthenticated,

    /// <summary>A conta não é de convidado: o dono confirma só com a passkey.</summary>
    NotAGuest,
    InvalidPassword,
    Locked,
}

internal sealed record ConfirmStepUpWithPasswordResult(
    ConfirmStepUpWithPasswordStatus Status,
    ConfirmStepUpResponse? Response = null,
    TimeSpan RetryAfter = default);

/// <summary>
/// A confirmação do convidado: ele não tem passkey, então reafirma a identidade digitando a senha de novo. Grava a mesma
/// <see cref="StepUpConfirmation"/> da passkey (presa à sessão e à ação, com a mesma validade curta), então quem a usa é a
/// política de confirmação de sempre. Só vale para as ações da lista fechada <see cref="GuestStepUpActions"/>, só para
/// conta de convidado, e errar a senha conta para o mesmo bloqueio do login (senão aqui se chutaria a senha sem custo).
/// </summary>
internal sealed class ConfirmStepUpWithPasswordHandler(
    IdentityDbContext db,
    PasswordService passwords,
    LoginAuditWriter audit,
    FailedLoginCounter failures,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options,
    IOptions<StepUpOptions> stepUp)
{
    public async Task<ConfirmStepUpWithPasswordResult> HandleAsync(
        ConfirmStepUpWithPasswordCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = time.GetUtcNow();
        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == command.UserId, cancellationToken);
        if (user is null || user.IsBlocked)
        {
            return new ConfirmStepUpWithPasswordResult(ConfirmStepUpWithPasswordStatus.Unauthenticated);
        }

        // Só convidado: o dono tem passkey, e a senha nunca substitui o passo forte dele.
        if (!string.Equals(user.Role, AccountRoles.Guest, StringComparison.Ordinal))
        {
            return new ConfirmStepUpWithPasswordResult(ConfirmStepUpWithPasswordStatus.NotAGuest);
        }

        var detail = $"{command.Action}|password";
        if (user.IsLockedOut(now))
        {
            audit.Add(user.Id, AuditEvents.LoginLocked, command.Client, detail);
            await db.SaveChangesAsync(cancellationToken);
            return new ConfirmStepUpWithPasswordResult(
                ConfirmStepUpWithPasswordStatus.Locked, RetryAfter: user.RemainingLockout(now));
        }

        var check = passwords.Verify(user, command.Password);
        if (check == PasswordCheck.Failed)
        {
            await failures.RegisterAsync(user.Id, now, options.Value.Lockout, cancellationToken);
            audit.Add(user.Id, AuditEvents.StepUpFailed, command.Client, detail);
            await db.SaveChangesAsync(cancellationToken);
            return new ConfirmStepUpWithPasswordResult(ConfirmStepUpWithPasswordStatus.InvalidPassword);
        }

        // Sessão já encerrada (logout ou reuso do refresh) não abre confirmação nova.
        var sessionAlive = await db.RefreshTokens.AnyAsync(
            t => t.FamilyId == command.SessionId && t.UserId == user.Id && t.RevokedAt == null, cancellationToken);
        if (!sessionAlive)
        {
            return new ConfirmStepUpWithPasswordResult(ConfirmStepUpWithPasswordStatus.Unauthenticated);
        }

        user.RegisterSuccess();
        if (check == PasswordCheck.SuccessRehashNeeded)
        {
            user.ReplacePasswordHash(passwords.Hash(command.Password));
        }

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        // Uma confirmação por (sessão, ação): confirmar de novo renova a validade em vez de empilhar linhas.
        var sessionId = command.SessionId;
        var action = command.Action;
        await db.StepUpConfirmations
            .Where(c => c.SessionFamilyId == sessionId && c.Action == action)
            .ExecuteDeleteAsync(cancellationToken);

        var confirmation = StepUpConfirmation.Create(user.Id, command.SessionId, action, now, stepUp.Value.Validity);
        db.StepUpConfirmations.Add(confirmation);
        audit.Add(user.Id, AuditEvents.StepUpSucceeded, command.Client, detail);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        return new ConfirmStepUpWithPasswordResult(
            ConfirmStepUpWithPasswordStatus.Confirmed,
            new ConfirmStepUpResponse(action, confirmation.ExpiresAt));
    }
}

internal static class ConfirmStepUpWithPasswordEndpoint
{
    public static void MapConfirmStepUpWithPassword(this IEndpointRouteBuilder group) =>
        group.MapPost("/step-up/password", HandleAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<ConfirmStepUpResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        ICurrentUser current,
        ConfirmStepUpWithPasswordRequest? request,
        ConfirmStepUpWithPasswordHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var errors = new Dictionary<string, string[]>();

        // Lista fechada: qualquer outra ação (inclusive as que pedem passkey) é recusada aqui, sem tocar na senha.
        if (!GuestStepUpActions.IsAllowed(request?.Action))
        {
            errors["action"] = ["Esta ação não pode ser confirmada com a senha."];
        }

        if (string.IsNullOrEmpty(request?.Password) || request.Password.Length > PasswordPolicy.MaximumLength)
        {
            errors["password"] = ["Informe a senha."];
        }

        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(
            new ConfirmStepUpWithPasswordCommand(userId, sessionId, request!.Action!, request.Password!, ClientInfo.From(http)),
            cancellationToken);

        return result.Status switch
        {
            ConfirmStepUpWithPasswordStatus.Confirmed => TypedResults.Ok(result.Response),
            ConfirmStepUpWithPasswordStatus.Locked => IdentityProblems.Locked(http.Response, result.RetryAfter),
            ConfirmStepUpWithPasswordStatus.InvalidPassword => IdentityProblems.InvalidPassword(),
            ConfirmStepUpWithPasswordStatus.NotAGuest => Results.Problem(
                statusCode: StatusCodes.Status403Forbidden,
                title: "Esta confirmação é só para convidados. Use a passkey."),
            _ => IdentityProblems.Unauthenticated(),
        };
    }
}
