using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Shopping.Domain;
using UniOver.Modules.Shopping.Persistence;

namespace UniOver.Modules.Shopping.Features;

/// <summary>O que uma escrita enxerga: o grupo de quem chama (nunca um grupo vindo do cliente) e a hora do servidor.</summary>
internal sealed class ShoppingScope(Guid groupId, Guid actorId, bool isOwner, DateTimeOffset now)
{
    private readonly List<(string EntityType, Guid EntityId, object Payload)> _changes = [];

    public Guid GroupId { get; } = groupId;
    public Guid ActorId { get; } = actorId;
    public bool IsOwner { get; } = isOwner;
    public DateTimeOffset Now { get; } = now;
    public IReadOnlyList<(string EntityType, Guid EntityId, object Payload)> Changes => _changes;

    /// <summary>Anota uma linha do feed; ela só existe se a escrita assentar.</summary>
    public void Change(string entityType, Guid entityId, object payload) => _changes.Add((entityType, entityId, payload));
}

/// <summary>O desfecho de uma escrita: a resposta e se ela assenta (grava) ou é recusada (nada fica).</summary>
internal readonly record struct WriteStep(IResult Result, bool Commit)
{
    public static WriteStep Done(IResult result) => new(result, true);

    public static WriteStep Rejected(IResult result) => new(result, false);
}

/// <summary>
/// Aplica uma operação pequena do cliente, uma por vez dentro do grupo.
/// <para>
/// A escrita abre uma transação e trava a linha do grupo. Com isso: (1) a sequência do feed sai na ordem em que as escritas
/// do grupo assentam, então quem lê "depois do cursor X" nunca perde uma linha que assentou atrasada; (2) duas escritas no
/// mesmo registro não se atropelam, vale a última que o servidor recebeu (menos o preço da linha da compra, que vale pelo
/// momento em que a pessoa o informou: o relógio do aparelho, descontada a diferença para o do servidor, ver
/// <see cref="ShoppingRules.ChangedAt"/>); (3) a mesma operação
/// enviada duas vezes ao mesmo tempo é aplicada uma vez só.
/// </para>
/// </summary>
internal sealed class ShoppingWriter(ShoppingDbContext db, ShoppingGroupService groups, TimeProvider time)
{
    private static readonly JsonSerializerOptions PayloadJson = new(JsonSerializerDefaults.Web);

    /// <param name="apply">Valida e altera as entidades; devolve a resposta e se a escrita assenta.</param>
    /// <param name="replay">A resposta de uma operação já aplicada: o estado atual do registro, lido só dentro do grupo.</param>
    public async Task<IResult> RunAsync(
        Guid userId,
        Guid operationId,
        Func<ShoppingScope, CancellationToken, Task<WriteStep>> apply,
        Func<Guid, CancellationToken, Task<IResult>> replay,
        CancellationToken cancellationToken)
    {
        if (operationId == Guid.Empty)
        {
            return ShoppingProblems.Invalid("operationId", "A operação precisa de um UUID.");
        }

        var groupId = (await groups.GetForUserAsync(userId, cancellationToken)).GroupId;

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlAsync($"""SELECT 1 FROM "shopping"."groups" WHERE id = {groupId} FOR UPDATE""", cancellationToken);

        // Relido com o grupo travado: a remoção de uma pessoa também passa por aqui, então não há escrita de quem já saiu.
        var member = await db.Members.AsNoTracking()
            .SingleOrDefaultAsync(x => x.GroupId == groupId && x.UserId == userId && x.DeletedAt == null, cancellationToken);
        if (member is null)
        {
            return ShoppingProblems.MembershipChanged();
        }

        var previous = await db.Operations.AsNoTracking().SingleOrDefaultAsync(x => x.Id == operationId, cancellationToken);
        if (previous is not null)
        {
            return previous.GroupId == groupId ? await replay(groupId, cancellationToken) : ShoppingProblems.OperationInUse();
        }

        var scope = new ShoppingScope(groupId, userId, member.IsOwner, time.GetUtcNow());
        var step = await apply(scope, cancellationToken);
        if (!step.Commit)
        {
            // Sem commit a transação se desfaz ao sair; o rastreador também é esvaziado para nada pendente sobrar.
            db.ChangeTracker.Clear();
            return step.Result;
        }

        db.Operations.Add(new ShoppingOperation { Id = operationId, GroupId = groupId, ActorUserId = userId, AppliedAt = scope.Now });
        foreach (var (entityType, entityId, payload) in scope.Changes)
        {
            db.Changes.Add(new ShoppingChange
            {
                GroupId = groupId,
                OperationId = operationId,
                EntityType = entityType,
                EntityId = entityId,
                Payload = JsonSerializer.Serialize(payload, payload.GetType(), PayloadJson),
                OccurredAt = scope.Now,
            });
        }

        try
        {
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // As unicidades do grupo são conferidas antes, com o grupo travado. O que sobra é um UUID que já existe fora
            // do alcance de quem chama (outro grupo, outra compra): recusa sem dizer de quem é.
            db.ChangeTracker.Clear();
            return ShoppingProblems.IdInUse();
        }

        return step.Result;
    }
}
