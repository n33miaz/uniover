using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.RemovePasskey;

internal enum RemovePasskeyStatus
{
    Removed,
    NotFound,
    LastPasskey,
}

internal sealed class RemovePasskeyHandler(IdentityDbContext db, LoginAuditWriter audit)
{
    public async Task<RemovePasskeyStatus> HandleAsync(
        Guid userId, Guid passkeyId, ClientInfo client, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);

        var count = await db.Passkeys.CountAsync(p => p.UserId == userId, cancellationToken);
        var passkey = await db.Passkeys.SingleOrDefaultAsync(p => p.Id == passkeyId && p.UserId == userId, cancellationToken);
        if (passkey is null)
        {
            return RemovePasskeyStatus.NotFound;
        }

        // Com uma só passkey o dono ficaria sem como confirmar nada até cadastrar outra: a trava impede o beco.
        if (!PasskeyRules.CanRemove(count))
        {
            return RemovePasskeyStatus.LastPasskey;
        }

        db.Passkeys.Remove(passkey);
        audit.Add(userId, AuditEvents.PasskeyRemoved, client, passkey.Id.ToString("N"));
        await db.SaveChangesAsync(cancellationToken);
        return RemovePasskeyStatus.Removed;
    }
}
