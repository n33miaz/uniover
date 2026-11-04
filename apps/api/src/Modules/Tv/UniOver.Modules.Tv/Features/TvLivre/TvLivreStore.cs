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

    /// <summary>
    /// Reserva o próximo número de aplicação da TV e o devolve, num único comando no banco (cria a linha na primeira vez).
    /// Nada de ler, somar e gravar na entidade: duas aplicações ao mesmo tempo, mesmo em instâncias diferentes, recebem
    /// números diferentes porque o PostgreSQL serializa o <c>UPDATE</c> da mesma linha.
    /// </summary>
    public async Task<int> NextRevisionAsync(Guid tvId, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var revisions = await db.Database.SqlQuery<int>($"""
            INSERT INTO tv.tv_livre (tv_id, revision, updated_at) VALUES ({tvId}, 1, {now})
            ON CONFLICT (tv_id) DO UPDATE SET revision = tv.tv_livre.revision + 1, updated_at = EXCLUDED.updated_at
            RETURNING revision AS "Value"
            """).ToListAsync(cancellationToken);
        return revisions.Single();
    }
}
