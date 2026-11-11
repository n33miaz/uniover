using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Adapters;

/// <summary>Responde se a sessão de login vale, pelo mesmo critério com que as demais rotas a procuram: um refresh da família, da pessoa, sem revogação.</summary>
internal sealed class SessionFamilyDirectory(IdentityDbContext db, TimeProvider time) : ISessionFamilyDirectory
{
    public Task<bool> IsActiveAsync(Guid userId, Guid familyId, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        return db.RefreshTokens.AsNoTracking()
            .AnyAsync(t => t.FamilyId == familyId && t.UserId == userId && t.RevokedAt == null && t.ExpiresAt > now, cancellationToken);
    }
}
