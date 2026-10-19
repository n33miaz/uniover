using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

internal sealed class EfShortcutReader(TvDbContext db) : ITvShortcutReader
{
    public async Task<IReadOnlyList<TvShortcut>> ListAsync(CancellationToken cancellationToken)
    {
        var shortcuts = await db.Shortcuts.AsNoTracking()
            .OrderBy(s => s.Position)
            .ToListAsync(cancellationToken);
        return [.. shortcuts.Select(TvShortcut.From)];
    }
}
