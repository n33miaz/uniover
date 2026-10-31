using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.PauseGuest;

internal enum PauseGuestStatus
{
    Done,
    NotFound,

    /// <summary>A conta já foi revogada: não há o que pausar nem retomar.</summary>
    Revoked,
}

/// <summary>
/// Pausa ou retoma a conta de um convidado. A pausa é reversível: não apaga nada, mas derruba as sessões e bloqueia
/// entrada, renovação, TV e permissões até o dono retomar. Só o dono chega aqui (política da rota).
/// </summary>
internal sealed class PauseGuestHandler(
    IdentityDbContext db, LoginAuditWriter audit, GuestAccountStatus status, AccessGrantsService grants, TimeProvider time)
{
    public async Task<PauseGuestStatus> PauseAsync(Guid ownerId, Guid guestId, ClientInfo client, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);

        // O filtro por papel impede pausar o dono, mesmo com um id certo.
        var guest = await db.Users.SingleOrDefaultAsync(u => u.Id == guestId && u.Role == AccountRoles.Guest, cancellationToken);
        if (guest is null)
        {
            return PauseGuestStatus.NotFound;
        }

        if (guest.IsDisabled)
        {
            return PauseGuestStatus.Revoked;
        }

        var now = time.GetUtcNow();
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        var wasPaused = guest.IsPaused;
        guest.Pause(now);
        await db.SaveChangesAsync(cancellationToken);

        // Repetir a pausa também limpa o que sobrou (uma sessão aberta no meio do caminho): é idempotente.
        await db.RefreshTokens
            .Where(t => t.UserId == guestId && t.RevokedAt == null)
            .ExecuteUpdateAsync(
                s => s.SetProperty(t => t.RevokedAt, now).SetProperty(t => t.RevokedReason, RevokeReasons.GuestPaused),
                cancellationToken);
        await db.StepUpConfirmations.Where(c => c.UserId == guestId).ExecuteDeleteAsync(cancellationToken);

        if (!wasPaused)
        {
            audit.Add(ownerId, AuditEvents.GuestPaused, client, guestId.ToString("N"));
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        status.MarkRevoked(guestId);
        grants.Invalidate(guestId);
        return PauseGuestStatus.Done;
    }

    public async Task<PauseGuestStatus> ResumeAsync(Guid ownerId, Guid guestId, ClientInfo client, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);

        var guest = await db.Users.SingleOrDefaultAsync(u => u.Id == guestId && u.Role == AccountRoles.Guest, cancellationToken);
        if (guest is null)
        {
            return PauseGuestStatus.NotFound;
        }

        if (guest.IsDisabled)
        {
            return PauseGuestStatus.Revoked;
        }

        if (guest.IsPaused)
        {
            guest.Resume();
            audit.Add(ownerId, AuditEvents.GuestResumed, client, guestId.ToString("N"));
            await db.SaveChangesAsync(cancellationToken);
        }

        // As sessões derrubadas na pausa não voltam: a pessoa entra de novo com a senha. Só o cache esquece a pausa.
        status.Forget(guestId);
        grants.Invalidate(guestId);
        return PauseGuestStatus.Done;
    }
}

internal static class PauseGuestEndpoint
{
    public static void MapPauseGuest(this IEndpointRouteBuilder group)
    {
        group.MapPost("/guests/{id:guid}/pause", PauseAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireIdempotency<IdentityDbContext>()
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        group.MapPost("/guests/{id:guid}/resume", ResumeAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireIdempotency<IdentityDbContext>()
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
    }

    private static async Task<IResult> PauseAsync(
        Guid id, HttpContext http, ICurrentUser current, PauseGuestHandler handler, CancellationToken cancellationToken) =>
        current.UserId is not { } userId
            ? IdentityProblems.Unauthenticated()
            : Map(await handler.PauseAsync(userId, id, ClientInfo.From(http), cancellationToken));

    private static async Task<IResult> ResumeAsync(
        Guid id, HttpContext http, ICurrentUser current, PauseGuestHandler handler, CancellationToken cancellationToken) =>
        current.UserId is not { } userId
            ? IdentityProblems.Unauthenticated()
            : Map(await handler.ResumeAsync(userId, id, ClientInfo.From(http), cancellationToken));

    private static IResult Map(PauseGuestStatus status) => status switch
    {
        PauseGuestStatus.Done => TypedResults.NoContent(),
        PauseGuestStatus.Revoked => IdentityProblems.GuestRevoked(),
        _ => TypedResults.NotFound(),
    };
}
