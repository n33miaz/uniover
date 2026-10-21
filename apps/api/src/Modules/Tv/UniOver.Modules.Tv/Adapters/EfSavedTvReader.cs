using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Lê a TV padrão do banco. O resolvedor é um singleton e o <see cref="TvDbContext"/> é de escopo, então cada leitura abre
/// o seu escopo, curto, só para a consulta.
/// </summary>
internal sealed class EfSavedTvReader(IServiceScopeFactory scopes) : ISavedTvReader
{
    public async Task<SavedTv?> ReadDefaultAsync(CancellationToken cancellationToken)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TvDbContext>();
        return await db.Tvs.AsNoTracking()
            .Where(t => t.IsDefault)
            .Select(t => new SavedTv(t.AgentSlug, t.Name))
            .FirstOrDefaultAsync(cancellationToken);
    }
}
