using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Features.ListPasskeys;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.RenamePasskey;

internal sealed class RenamePasskeyHandler(IdentityDbContext db)
{
    /// <summary>Nulo se a passkey não existe ou é de outro usuário (a resposta não distingue os dois casos).</summary>
    public async Task<PasskeySummary?> HandleAsync(
        Guid userId, Guid passkeyId, string name, CancellationToken cancellationToken = default)
    {
        var passkey = await db.Passkeys.SingleOrDefaultAsync(p => p.Id == passkeyId && p.UserId == userId, cancellationToken);
        if (passkey is null)
        {
            return null;
        }

        passkey.Rename(name);
        await db.SaveChangesAsync(cancellationToken);
        return new PasskeySummary(passkey.Id, passkey.Name, passkey.CreatedAt, passkey.LastUsedAt);
    }
}
