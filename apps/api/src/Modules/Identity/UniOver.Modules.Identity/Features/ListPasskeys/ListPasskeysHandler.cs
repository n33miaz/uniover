using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.ListPasskeys;

internal sealed record PasskeySummary(Guid Id, string Name, DateTimeOffset CreatedAt, DateTimeOffset? LastUsedAt);

internal sealed class ListPasskeysHandler(IdentityDbContext db)
{
    /// <summary>Só o que a tela precisa: nunca a chave pública nem o identificador da credencial.</summary>
    public async Task<IReadOnlyList<PasskeySummary>> HandleAsync(Guid userId, CancellationToken cancellationToken = default) =>
        await db.Passkeys
            .Where(p => p.UserId == userId)
            .OrderBy(p => p.CreatedAt)
            .Select(p => new PasskeySummary(p.Id, p.Name, p.CreatedAt, p.LastUsedAt))
            .ToListAsync(cancellationToken);
}
