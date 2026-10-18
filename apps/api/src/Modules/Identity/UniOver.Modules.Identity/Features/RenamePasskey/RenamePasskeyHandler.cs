using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.RenamePasskey;

internal sealed record RenamedPasskey(Guid Id, string Name, DateTimeOffset CreatedAt, DateTimeOffset? LastUsedAt);

internal sealed class RenamePasskeyHandler(IdentityDbContext db)
{
    /// <summary>Nulo se a passkey não existe ou é de outro usuário (a resposta não distingue os dois casos).</summary>
    public async Task<RenamedPasskey?> HandleAsync(
        Guid userId, Guid passkeyId, string name, CancellationToken cancellationToken = default)
    {
        var passkey = await db.Passkeys.SingleOrDefaultAsync(p => p.Id == passkeyId && p.UserId == userId, cancellationToken);
        if (passkey is null)
        {
            return null;
        }

        passkey.Rename(name);
        await db.SaveChangesAsync(cancellationToken);
        return new RenamedPasskey(passkey.Id, passkey.Name, passkey.CreatedAt, passkey.LastUsedAt);
    }
}
