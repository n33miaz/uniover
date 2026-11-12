using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Adapters;

/// <summary>
/// Responde o nome das contas. Quem "tem a permissão" segue a mesma regra da conferência de acesso: conta ativa, e o
/// administrador tem todas sem linha de concessão; o convidado precisa da linha.
/// </summary>
internal sealed class AccountDirectory(IdentityDbContext db) : IAccountDirectory
{
    public async Task<IReadOnlyList<AccountName>> WithPermissionAsync(string permission, CancellationToken cancellationToken = default)
    {
        if (!AccessPermissions.IsKnown(permission))
        {
            return [];
        }

        return await db.Users.AsNoTracking()
            .Where(u => u.DisabledAt == null && u.PausedAt == null)
            .Where(u => u.Role == AccountRoles.Owner
                || (u.Role == AccountRoles.Guest && db.UserGrants.Any(g => g.UserId == u.Id && g.Permission == permission)))
            .OrderBy(u => u.DisplayName)
            .ThenBy(u => u.Id)
            .Select(u => new AccountName(u.Id, u.DisplayName))
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<AccountName>> NamesAsync(IReadOnlyCollection<Guid> userIds, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(userIds);

        if (userIds.Count == 0)
        {
            return [];
        }

        var ids = userIds.ToArray();
        return await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .Select(u => new AccountName(u.Id, u.DisplayName))
            .ToListAsync(cancellationToken);
    }
}
