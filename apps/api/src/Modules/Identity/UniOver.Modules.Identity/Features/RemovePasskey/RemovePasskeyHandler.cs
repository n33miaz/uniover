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

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        // Serializa remoções do mesmo dono: sem esse lock, duas requisições contam duas chaves e apagam uma cada.
        _ = await db.Users
            .FromSqlInterpolated($"SELECT * FROM identity.users WHERE id = {userId} FOR UPDATE")
            .AsNoTracking()
            .ToListAsync(cancellationToken);

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
        await transaction.CommitAsync(cancellationToken);
        return RemovePasskeyStatus.Removed;
    }
}
