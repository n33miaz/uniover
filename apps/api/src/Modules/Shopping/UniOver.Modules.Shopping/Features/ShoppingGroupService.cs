using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Shopping.Domain;
using UniOver.Modules.Shopping.Persistence;

namespace UniOver.Modules.Shopping.Features;

/// <summary>
/// Diz qual é o grupo de quem chama. É a ÚNICA fonte do grupo para as rotas do módulo: nenhuma rota recebe o grupo do
/// cliente, então não há como pedir o de outra pessoa. No primeiro acesso, cria o grupo e torna a pessoa dona dele.
/// </summary>
internal sealed class ShoppingGroupService(ShoppingDbContext db, TimeProvider time)
{
    public async Task<ShoppingMember> GetForUserAsync(Guid userId, CancellationToken cancellationToken)
    {
        var member = await FindAsync(userId, cancellationToken);
        if (member is not null)
        {
            return member;
        }

        var now = time.GetUtcNow();
        var group = new ShoppingGroup { Id = Guid.CreateVersion7(), OwnerUserId = userId, CreatedAt = now };
        var created = new ShoppingMember { GroupId = group.Id, UserId = userId, IsOwner = true, CreatedAt = now, Group = group };
        db.Groups.Add(group);
        db.Members.Add(created);
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Dois primeiros acessos ao mesmo tempo (ou um convite que chegou no meio): vale a participação que assentou.
            db.ChangeTracker.Clear();
            return await FindAsync(userId, cancellationToken) ?? throw new InvalidOperationException("A participação no grupo de compras não assentou.", ex);
        }

        db.ChangeTracker.Clear();
        return created;
    }

    private Task<ShoppingMember?> FindAsync(Guid userId, CancellationToken cancellationToken) =>
        db.Members.AsNoTracking().Include(x => x.Group).SingleOrDefaultAsync(x => x.UserId == userId && x.DeletedAt == null, cancellationToken);
}
