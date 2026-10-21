using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.ListPasskeys;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.RenamePasskey;

internal sealed class RenamePasskeyHandler(IdentityDbContext db, LoginAuditWriter audit)
{
    /// <summary>Nulo se a passkey não existe ou é de outro usuário (a resposta não distingue os dois casos).</summary>
    public async Task<PasskeySummary?> HandleAsync(
        Guid userId, Guid passkeyId, string name, ClientInfo client, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);

        var passkey = await db.Passkeys.SingleOrDefaultAsync(p => p.Id == passkeyId && p.UserId == userId, cancellationToken);
        if (passkey is null)
        {
            return null;
        }

        passkey.Rename(name);

        // Só o id da passkey vai para a trilha: o nome é texto livre da pessoa e não é preciso para saber o que aconteceu.
        audit.Add(userId, AuditEvents.PasskeyRenamed, client, passkey.Id.ToString("N"));
        await db.SaveChangesAsync(cancellationToken);
        return new PasskeySummary(passkey.Id, passkey.Name, passkey.CreatedAt, passkey.LastUsedAt);
    }
}
