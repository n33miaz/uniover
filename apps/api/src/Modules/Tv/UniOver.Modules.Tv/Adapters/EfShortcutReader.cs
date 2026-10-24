using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

internal sealed class EfShortcutReader(TvDbContext db) : ITvShortcutReader
{
    public async Task<IReadOnlyList<TvShortcut>> ListAsync(Guid tvId, CancellationToken cancellationToken)
    {
        var shortcuts = await db.Shortcuts.AsNoTracking()
            .Where(s => s.TvId == tvId)
            .OrderBy(s => s.Position)

            // Desempate fixo: uma lista nova do agente chegando junto de uma reordenação pode repetir uma posição por um instante.
            .ThenBy(s => s.Id)
            .ToListAsync(cancellationToken);
        return [.. shortcuts.Select(TvShortcut.From)];
    }
}
