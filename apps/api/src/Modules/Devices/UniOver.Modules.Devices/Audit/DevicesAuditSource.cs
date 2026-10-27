using System.Globalization;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Devices.Audit;

/// <summary>
/// Os códigos de ação do pareamento como a trilha unificada os mostra. A tabela guarda palavras soltas
/// (<c>approved</c>, <c>denied</c>), que numa trilha com várias fontes seriam ambíguas; aqui cada uma leva o nome do
/// assunto. A tradução vale nos dois sentidos, porque o filtro por ação volta ao valor gravado na consulta.
/// </summary>
internal static class DevicesAuditActions
{
    private static readonly (string Stored, string Action)[] Map =
    [
        (PairingEvents.Started, "pairing_started"),
        (PairingEvents.Approved, "pairing_approved"),
        (PairingEvents.Denied, "pairing_denied"),
        (PairingEvents.Expired, "pairing_expired"),
        (PairingEvents.TokenIssued, "pairing_token_issued"),
        (PairingEvents.AgentRevoked, "agent_revoked"),
        (PairingEvents.AgentLogsViewed, "agent_logs_viewed"),
        (PairingEvents.AgentUpdateRequested, "agent_update_requested"),
        (PairingEvents.AgentRestartRequested, "agent_restart_requested"),
        (PairingEvents.AgentRollbackRequested, "agent_rollback_requested"),
        (PairingEvents.AgentOffline, "agent_offline"),
        (PairingEvents.AgentOnline, "agent_online"),
    ];

    public static IReadOnlyList<string> All { get; } = [.. Map.Select(m => m.Action)];

    /// <summary>O código da trilha para o valor gravado; um valor que o código não conhece passa como está (nunca some).</summary>
    public static string ToAction(string stored) => Map.FirstOrDefault(m => m.Stored == stored).Action ?? stored;

    /// <summary>O valor gravado para um código de ação da trilha, ou nulo se o código não é desta fonte.</summary>
    public static string? ToStored(string action) => Map.FirstOrDefault(m => m.Action == action).Stored;
}

internal static class DevicesAuditNormalizer
{
    public const string Module = "devices";

    public static AuditOutcome OutcomeOf(string storedEvent) => storedEvent switch
    {
        // Um pedido que o administrador recusou, e um que venceu sem ser aprovado, não foram um sucesso.
        PairingEvents.Denied => AuditOutcome.Denied,
        PairingEvents.Expired => AuditOutcome.Failure,
        _ => AuditOutcome.Success,
    };

    /// <param name="agentName">Nome do aparelho (do cadastro de agentes), quando a linha cita um agente que existe.</param>
    public static AuditRecord Normalize(PairingAuditEntry entry, string? agentName)
    {
        ArgumentNullException.ThrowIfNull(entry);

        return new AuditRecord(
            entry.Id,
            entry.OccurredAt,
            Module,
            DevicesAuditActions.ToAction(entry.Event),
            entry.UserId,
            agentName,
            null,
            OutcomeOf(entry.Event),

            // O id do pedido liga os passos do mesmo pareamento (começou, aprovou, entregou o token).
            entry.PairingId?.ToString("N", CultureInfo.InvariantCulture),
            entry.Ip,
            entry.UserAgent);
    }
}

/// <summary>Lê <c>pairing_audit</c> como uma fonte da trilha unificada: só leitura, com o papel da aplicação.</summary>
internal sealed class DevicesAuditSource(DevicesDbContext db) : IAuditSource
{
    public AuditSourceInfo Info { get; } = new(
        DevicesAuditNormalizer.Module, AuditRetentionPolicy.SecurityDays, DevicesAuditActions.All);

    public async Task<IReadOnlyList<AuditRecord>> ReadAsync(AuditQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        IQueryable<PairingAuditEntry> rows = db.PairingAudit.AsNoTracking();

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
            var stored = actions.Select(DevicesAuditActions.ToStored).OfType<string>().ToArray();
            rows = rows.Where(r => stored.Contains(r.Event));
        }

        if (query.Outcome is { } outcome)
        {
            var denied = PairingEvents.Denied;
            var expired = PairingEvents.Expired;
            rows = outcome switch
            {
                AuditOutcome.Denied => rows.Where(r => r.Event == denied),
                AuditOutcome.Failure => rows.Where(r => r.Event == expired),
                _ => rows.Where(r => r.Event != denied && r.Event != expired),
            };
        }

        // Aqui só a conta que agiu: os passos do agente (sem login) não têm conta e ficam de fora de um filtro por pessoa.
        if (query.PersonId is { } person)
        {
            rows = rows.Where(r => r.UserId == person);
        }

        if (query.After is { } cursor)
        {
            var at = cursor.OccurredAt;
            var id = cursor.Id;
            rows = cursor.TieFor(DevicesAuditNormalizer.Module) switch
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

        // O nome do aparelho vem do cadastro de agentes (mesmo schema), numa consulta só para a página.
        var agentIds = found.Select(r => r.AgentId).OfType<Guid>().Distinct().ToList();
        var names = agentIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await db.Agents.AsNoTracking()
                .Where(a => agentIds.Contains(a.Id))
                .Select(a => new { a.Id, a.Name })
                .ToDictionaryAsync(a => a.Id, a => a.Name, cancellationToken);

        return [.. found.Select(r => DevicesAuditNormalizer.Normalize(r, r.AgentId is { } agent ? names.GetValueOrDefault(agent) : null))];
    }
}
