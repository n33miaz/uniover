using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.TvLivre;

/// <summary>
/// Acesso à linha do TV Livre de uma TV. A linha nasce na primeira escrita (configuração, foto, aplicação ou o primeiro
/// estado do agente), e essas quatro coisas podem chegar ao mesmo tempo (a tela salva enquanto o agente responde): por
/// isso a criação é um <c>INSERT ... ON CONFLICT DO NOTHING</c> seguido da leitura, e nunca "procurar e, se não achar,
/// adicionar", que duas requisições simultâneas fariam as duas e uma delas quebraria na chave primária.
/// </summary>
internal sealed class TvLivreStore(TvDbContext db, TimeProvider time)
{
    public async Task<TvLivreEntry> EnsureAsync(Guid tvId, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO tv.tv_livre (tv_id, revision, updated_at) VALUES ({tvId}, 0, {now}) ON CONFLICT (tv_id) DO NOTHING",
            cancellationToken);
        return await db.TvLivre.SingleAsync(entry => entry.TvId == tvId, cancellationToken);
    }
}
