using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Logout;

internal sealed record LogoutCommand(Guid UserId, Guid SessionId, ClientInfo Client);

internal sealed class LogoutHandler(IdentityDbContext db, LoginAuditWriter audit, TimeProvider time)
{
    /// <summary>Revoga a família inteira: o refresh dessa sessão deixa de valer em qualquer aba.</summary>
    public async Task HandleAsync(LogoutCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = time.GetUtcNow();
        var familyId = command.SessionId;
        var userId = command.UserId;

        // O filtro por usuário impede que um JWT forjado com a família de outra pessoa a revogue.
        await db.RefreshTokens
            .Where(t => t.FamilyId == familyId && t.UserId == userId && t.RevokedAt == null)
            .ExecuteUpdateAsync(
                s => s.SetProperty(t => t.RevokedAt, now).SetProperty(t => t.RevokedReason, RevokeReasons.Logout),
                cancellationToken);

        // As confirmações da sessão acabam junto com ela, sem esperar o vencimento.
        await db.StepUpConfirmations
            .Where(c => c.SessionFamilyId == familyId && c.UserId == userId)
            .ExecuteDeleteAsync(cancellationToken);

        audit.Add(userId, AuditEvents.Logout, command.Client);
        await db.SaveChangesAsync(cancellationToken);
    }
}
