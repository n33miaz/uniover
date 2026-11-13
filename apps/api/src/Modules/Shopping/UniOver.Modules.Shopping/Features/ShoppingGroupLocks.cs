using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Shopping.Persistence;

namespace UniOver.Modules.Shopping.Features;

/// <summary>
/// A trava da linha do grupo, num lugar só. Quem precisa de mais de um grupo na mesma transação (aceitar um convite,
/// incluir alguém que já tem grupo) trava todos aqui, sempre na mesma ordem global (a do UUID): dois pedidos cruzados
/// nunca ficam um esperando o outro.
/// </summary>
internal static class ShoppingGroupLocks
{
    /// <summary>Os grupos sem repetição, na ordem em que devem ser travados.</summary>
    public static Guid[] InOrder(IEnumerable<Guid> groupIds) => [.. groupIds.Distinct().Order()];

    /// <summary>Trava os grupos na ordem global. Precisa estar dentro de uma transação: a trava vale até o fim dela.</summary>
    public static async Task LockAsync(ShoppingDbContext db, IEnumerable<Guid> groupIds, CancellationToken cancellationToken)
    {
        foreach (var groupId in InOrder(groupIds))
        {
            await db.Database.ExecuteSqlAsync($"""SELECT 1 FROM "shopping"."groups" WHERE id = {groupId} FOR UPDATE""", cancellationToken);
        }
    }
}
