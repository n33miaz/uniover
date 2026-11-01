using Microsoft.EntityFrameworkCore;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Trava transacional por família de refresh. Girar, sair e revogar passam todos por ela: sem isso um refresh em voo
/// podia inserir o sucessor depois de o "Sair" ter revogado os tokens que existiam, deixando uma sessão viva.
/// Solta sozinha no fim da transação; quem chama precisa estar dentro de uma.
/// </summary>
internal static class FamilyLock
{
    public static async Task AcquireAsync(DbContext db, Guid familyId, CancellationToken cancellationToken) =>
        await db.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({familyId.ToString("N")}, 0))",
            cancellationToken);

    /// <summary>Várias famílias numa ordem estável, para duas revogações em massa nunca esperarem uma pela outra.</summary>
    public static async Task AcquireAllAsync(DbContext db, IEnumerable<Guid> familyIds, CancellationToken cancellationToken)
    {
        foreach (var familyId in familyIds.Distinct().Order())
        {
            await AcquireAsync(db, familyId, cancellationToken);
        }
    }
}
