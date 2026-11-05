using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.Tvs;

/// <summary>
/// Serializa quem muda a própria TV (trocar o computador, ajustes) com quem a remove. O bloqueio de linha do Postgres
/// vale até o commit ou o rollback da transação aberta pelo chamador e deve ser tomado ANTES de ler a TV: assim a leitura
/// já enxerga o que a outra gravação confirmou. Sem ele, a remoção lia a TV com o computador antigo, uma troca de
/// computador confirmava no meio, e a trilha permanente registrava o computador e o tipo errados para uma TV que já
/// estava ligada a outro.
/// </summary>
internal static class TvRowLock
{
    /// <summary>Se a TV não existe, não bloqueia nada: a leitura seguinte devolve nulo e o chamador trata como "não existe".</summary>
    public static Task LockAsync(TvDbContext db, Guid tvId, CancellationToken cancellationToken) =>
        db.Database.ExecuteSqlInterpolatedAsync($"""SELECT id FROM "tv"."tvs" WHERE id = {tvId} FOR UPDATE""", cancellationToken);
}
