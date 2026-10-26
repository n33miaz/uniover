using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.Tvs;

/// <summary>
/// Mantém a marca de "já teve filiação e foi retirada" (<see cref="TvMemberOptOut"/>) coerente com as filiações. Toda
/// gravação de filiação (trocar os membros de uma TV, apagar a TV, aprovar um computador já com membros) passa por aqui,
/// dentro da MESMA transação da mudança: a marca nunca fica para trás nem aparece sem a filiação ter saído.
/// </summary>
internal static class TvMembershipLedger
{
    private const string LockKey = "uniover:tv-members";

    /// <summary>
    /// Serializa as gravações de filiação (bloqueio de transação do Postgres, solto no commit ou no rollback). Sem ele,
    /// duas remoções simultâneas de filiações da mesma conta enxergam, cada uma, a filiação que a outra está tirando e
    /// nenhuma grava a marca: a conta ficaria sem filiação e sem marca, e voltaria a cair na TV padrão do dono. Mudar
    /// filiação é ação rara do administrador, então a fila não custa nada, e um bloqueio único não tem como travar em ciclo.
    /// </summary>
    public static Task LockAsync(TvDbContext db, CancellationToken cancellationToken) =>
        db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtextextended({LockKey}, 0))", cancellationToken);

    /// <summary>
    /// Ajusta as marcas para a mudança de filiação da TV <paramref name="tvId"/>, que o chamador grava no mesmo
    /// <c>SaveChanges</c>: quem entra perde a marca; quem sai sem outra filiação ganha uma. Só vale com o bloqueio de
    /// <see cref="LockAsync"/> já tomado, que garante a leitura das filiações que outras gravações já confirmaram.
    /// </summary>
    public static async Task ReconcileAsync(
        TvDbContext db,
        Guid tvId,
        IReadOnlyCollection<Guid> removed,
        IReadOnlyCollection<Guid> added,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(removed);
        ArgumentNullException.ThrowIfNull(added);

        if (added.Count > 0)
        {
            var returning = added.ToArray();
            db.TvMemberOptOuts.RemoveRange(await db.TvMemberOptOuts.Where(o => returning.Contains(o.UserId)).ToListAsync(cancellationToken));
        }

        if (removed.Count == 0)
        {
            return;
        }

        // A TV em mudança fica de fora da conta: nela a pessoa está saindo (a linha ainda existe até o SaveChanges).
        var leaving = removed.ToArray();
        var staying = await db.TvMembers.AsNoTracking()
            .Where(m => m.TvId != tvId && leaving.Contains(m.UserId))
            .Select(m => m.UserId)
            .Distinct()
            .ToListAsync(cancellationToken);
        var lost = leaving.Except(staying).ToArray();
        if (lost.Length == 0)
        {
            return;
        }

        var marked = await db.TvMemberOptOuts.AsNoTracking()
            .Where(o => lost.Contains(o.UserId))
            .Select(o => o.UserId)
            .ToListAsync(cancellationToken);
        db.TvMemberOptOuts.AddRange(lost.Except(marked).Select(userId => TvMemberOptOut.Create(userId, now)));
    }
}
