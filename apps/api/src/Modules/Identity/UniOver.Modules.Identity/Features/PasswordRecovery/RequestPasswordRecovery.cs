using System.Diagnostics;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.PasswordRecovery;

internal sealed record RequestPasswordRecoveryRequest(string? Email);

internal sealed class RequestPasswordRecoveryHandler(
    IdentityDbContext db, IRecoveryEmailSender sender, RecoveryEmailQueue queue,
    LoginAuditWriter audit, TimeProvider time)
{
    public async Task HandleAsync(string? emailInput, ClientInfo client, CancellationToken cancellationToken)
    {
        // A resposta é a mesma para conta ausente, bloqueada, já limitada ou envio desligado.
        if (!sender.Available || !EmailRules.IsValid(emailInput?.Trim())) return;
        var email = EmailRules.Normalize(emailInput!);
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Email == email, cancellationToken);
        if (user is null || user.IsBlocked) return;

        var now = time.GetUtcNow();
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({user.Id.ToString("N")}, 43))", cancellationToken);
        var recent = await db.PasswordResetTokens.CountAsync(
            t => t.UserId == user.Id && t.CreatedAt > now.AddHours(-1), cancellationToken);
        if (recent >= 3) return;

        var (token, hash) = SecretTokens.Generate();
        var reset = PasswordResetToken.Create(user.Id, hash, now);
        db.PasswordResetTokens.Add(reset);
        audit.Add(null, AuditEvents.PasswordRecoveryRequested, client, AuditAboutAccount.Detail(user.Id));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        if (!queue.TryQueue(email, token))
        {
            // A fila em memória está cheia: sem e-mail, o token não serve. A resposta permanece neutra.
            await db.PasswordResetTokens.Where(t => t.Id == reset.Id).ExecuteDeleteAsync(cancellationToken);
        }
    }
}

internal static class RequestPasswordRecoveryEndpoint
{
    public static void MapRequestPasswordRecovery(this IEndpointRouteBuilder group) =>
        group.MapPost("/auth/password/recovery", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces(StatusCodes.Status202Accepted);

    private static async Task<IResult> HandleAsync(
        HttpContext http, RequestPasswordRecoveryRequest? request,
        RequestPasswordRecoveryHandler handler, CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request)) return IdentityProblems.MissingClientHeader();

        var started = Stopwatch.GetTimestamp();
        await handler.HandleAsync(request?.Email, ClientInfo.From(http), cancellationToken);
        var elapsed = Stopwatch.GetElapsedTime(started);
        if (elapsed < TimeSpan.FromMilliseconds(300))
            await Task.Delay(TimeSpan.FromMilliseconds(300) - elapsed, cancellationToken);
        return Results.StatusCode(StatusCodes.Status202Accepted);
    }
}
