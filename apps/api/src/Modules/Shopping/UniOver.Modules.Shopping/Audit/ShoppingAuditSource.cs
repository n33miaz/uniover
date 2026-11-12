using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Shopping.Domain;
using UniOver.Modules.Shopping.Persistence;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Shopping.Audit;

/// <summary>O que a tabela guarda em cada linha da trilha de pessoas do grupo.</summary>
internal static class ShoppingAuditEvents
{
    public const string MemberAdded = "member_added";
    public const string MemberRemoved = "member_removed";
}

/// <summary>
/// Os códigos de ação como a trilha unificada os mostra. A tabela guarda palavras soltas (<c>member_added</c>), que
/// numa trilha com várias fontes seriam ambíguas; aqui cada uma leva o nome do módulo. A tradução vale nos dois
/// sentidos, porque o filtro por ação volta ao valor gravado na consulta.
/// </summary>
internal static class ShoppingAuditActions
{
    public const string MemberAdd = "shopping.member.add";
    public const string MemberRemove = "shopping.member.remove";

    private static readonly (string Stored, string Action)[] Map =
    [
        (ShoppingAuditEvents.MemberAdded, MemberAdd),
        (ShoppingAuditEvents.MemberRemoved, MemberRemove),
    ];

    public static IReadOnlyList<string> All { get; } = [.. Map.Select(m => m.Action)];

    /// <summary>O código da trilha para o valor gravado; um valor que o código não conhece passa como está (nunca some).</summary>
    public static string ToAction(string stored) => Map.FirstOrDefault(m => m.Stored == stored).Action ?? stored;

    /// <summary>O valor gravado para um código de ação da trilha, ou nulo se o código não é desta fonte.</summary>
    public static string? ToStored(string action) => Map.FirstOrDefault(m => m.Action == action).Stored;
}

/// <summary>
/// A trilha de Compras para o administrador: só quem entrou e quem saiu de um grupo, nunca os toques da lista ou do
/// mercado. Segue o prazo das trilhas de segurança (<c>shopping.purge_audit</c>).
/// </summary>
internal sealed class ShoppingAuditSource(ShoppingDbContext db) : IAuditSource
{
    public const string Module = "shopping";

    public AuditSourceInfo Info { get; } = new(Module, AuditRetentionPolicy.SecurityDays, ShoppingAuditActions.All);

    public async Task<IReadOnlyList<AuditRecord>> ReadAsync(AuditQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        IQueryable<ShoppingMemberAuditEntry> rows = db.MemberAudit.AsNoTracking();
        if (query.From is { } from)
        {
            rows = rows.Where(r => r.OccurredAt >= from);
        }

        if (query.To is { } to)
        {
            rows = rows.Where(r => r.OccurredAt < to);
        }

        if (query.Actions is { Count: > 0 } actions)
        {
            var stored = actions.Select(ShoppingAuditActions.ToStored).OfType<string>().ToList();
            rows = rows.Where(r => stored.Contains(r.Event));
        }

        // Só o que assentou é gravado: não há linha de falha nem de recusa.
        if (query.Outcome is { } outcome && outcome != AuditOutcome.Success)
        {
            rows = rows.Where(_ => false);
        }

        if (query.PersonId is { } person)
        {
            rows = rows.Where(r => r.ActorUserId == person || r.TargetUserId == person);
        }

        if (query.After is { } cursor)
        {
            var at = cursor.OccurredAt;
            var id = cursor.Id;
            rows = cursor.TieFor(Module) switch
            {
                AuditTie.SameSource => rows.Where(r => r.OccurredAt < at || (r.OccurredAt == at && r.Id.CompareTo(id) < 0)),
                AuditTie.IncludeSameInstant => rows.Where(r => r.OccurredAt <= at),
                _ => rows.Where(r => r.OccurredAt < at),
            };
        }

        var found = await rows
            .OrderByDescending(r => r.OccurredAt)
            .ThenByDescending(r => r.Id)
            .Take(query.Limit)
            .ToListAsync(cancellationToken);

        return [.. found.Select(r => new AuditRecord(
            r.Id,
            r.OccurredAt,
            Module,
            ShoppingAuditActions.ToAction(r.Event),
            r.ActorUserId,
            null,
            r.TargetUserId,
            AuditOutcome.Success,
            null,
            null,
            null))];
    }
}
