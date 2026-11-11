using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Adapters;

/// <summary>Responde o papel das contas lendo a coluna que também vira a claim de papel do token.</summary>
internal sealed class AccountRoleDirectory(IdentityDbContext db) : IAccountRoleDirectory
{
    public async Task<IReadOnlyCollection<Guid>> OwnersAmongAsync(IReadOnlyCollection<Guid> userIds, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(userIds);

        if (userIds.Count == 0)
        {
            return [];
        }

        var ids = userIds.ToArray();
        return await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id) && u.Role == AccountRoles.Owner)
            .Select(u => u.Id)
            .ToListAsync(cancellationToken);
    }
}
