using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Adapters;

/// <summary>
/// O <see cref="IAgentDirectory"/> sobre o banco do Devices. Projeta só os quatro campos do contrato: o hash do token e
/// o resto da linha nunca são nem lidos para fora do módulo.
/// </summary>
internal sealed class EfAgentDirectory(DevicesDbContext db) : IAgentDirectory
{
    public async Task<AgentListing?> FindAsync(string slug, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(slug))
        {
            return null;
        }

        return await db.Agents.AsNoTracking()
            .Where(a => a.Slug == slug)
            .Select(a => new AgentListing(a.Slug, a.Name, a.Platform, a.RevokedAt != null))
            .SingleOrDefaultAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<AgentListing>> ListActiveAsync(CancellationToken cancellationToken = default) =>
        await db.Agents.AsNoTracking()
            .Where(a => a.RevokedAt == null)
            .OrderBy(a => a.CreatedAt)
            .Select(a => new AgentListing(a.Slug, a.Name, a.Platform, false))
            .ToListAsync(cancellationToken);
}
