using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Tv.Audit;

internal static class TvAuditNormalizer
{
    public const string Module = "tv";

    /// <summary>Toda ação da trilha da TV, na ordem em que a tela as lista.</summary>
    public static IReadOnlyList<string> Actions { get; } =
    [
        TvCommandNames.Add,
        TvCommandNames.Remove,
        TvCommandNames.Key,
        TvCommandNames.Text,
        TvCommandNames.AppLaunch,
        TvCommandNames.Wake,
        TvCommandNames.PowerOff,
        TvCommandNames.PowerSchedule,
        TvCommandNames.Cleanup,
        TvCommandNames.SettingsOpen,
        TvCommandNames.PermissionRequest,
        TvCommandNames.Pair,
        TvCommandNames.Discover,
        TvCommandNames.LivreRefresh,
        TvCommandNames.LivreInstall,
        TvCommandNames.LivreApply,
        TvCommandNames.LivreSetHome,
        TvCommandNames.LivreRestore,
        TvCommandNames.LivreSetApps,
        TvCommandNames.LivreSleep,
        TvCommandNames.CleanupSetting,
        TvCommandNames.AppsRefresh,
        TvCommandNames.ShortcutsReorder,
        TvCommandNames.ShortcutUpdate,
        TvCommandNames.ConfigBind,
        TvCommandNames.SiriTokenCreate,
        TvCommandNames.SiriTokenRevoke,
        TvCommandNames.SiriDenied,
        TvCommandNames.AuditLimit,
    ];

    /// <summary>
    /// O alvo é a tecla, o pacote do app ou uma contagem (<c>length=N</c> para texto digitado, <c>count=N</c> para a
    /// ordem dos atalhos): a tabela nunca guarda o conteúdo digitado. O detalhe é o código de erro, quando falhou.
    /// </summary>
    public static AuditRecord Normalize(CommandAuditEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);

        return new AuditRecord(
            entry.Id,
            entry.OccurredAt,
            Module,
            entry.Command,
            entry.UserId,
            entry.Detail,
            null,
            entry.Ok ? AuditOutcome.Success : AuditOutcome.Failure,
            entry.ErrorCode,
            entry.Ip,
            entry.UserAgent);
    }

    public static AuditRecord Normalize(TvRemovalAuditEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);

        return new AuditRecord(
            entry.Id,
            entry.OccurredAt,
            Module,
            TvCommandNames.Remove,
            entry.UserId,
            $"kind={entry.Kind} agent={entry.AgentId}",
            null,
            AuditOutcome.Success,
            null,
            entry.Ip,
            entry.UserAgent);
    }
}

/// <summary>Lê os comandos e as remoções permanentes como uma única fonte da trilha unificada, só com o papel da aplicação.</summary>
internal sealed class TvAuditSource(TvDbContext db) : IAuditSource
{
    // Os comandos duram CommandDays; a remoção de uma TV (quem, quando, qual computador) fica sem prazo, e só o IP e o
    // aparelho dela seguem o prazo das trilhas de segurança (tv.scrub_removal_audit).
    public AuditSourceInfo Info { get; } = new(
        TvAuditNormalizer.Module, AuditRetentionPolicy.CommandDays, TvAuditNormalizer.Actions, [TvCommandNames.Remove]);

    public async Task<IReadOnlyList<AuditRecord>> ReadAsync(AuditQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        IQueryable<CommandAuditEntry> commandRows = db.CommandAudit.AsNoTracking()
            .Where(r => r.Command != TvCommandNames.Remove);
        IQueryable<TvRemovalAuditEntry> removalRows = db.TvRemovalAudit.AsNoTracking();

        if (query.From is { } from)
        {
            commandRows = commandRows.Where(r => r.OccurredAt >= from);
            removalRows = removalRows.Where(r => r.OccurredAt >= from);
        }

        if (query.To is { } to)
        {
            commandRows = commandRows.Where(r => r.OccurredAt < to);
            removalRows = removalRows.Where(r => r.OccurredAt < to);
        }

        if (query.Actions is { Count: > 0 } actions)
        {
            var wanted = actions.ToArray();
            commandRows = commandRows.Where(r => wanted.Contains(r.Command));
            removalRows = wanted.Contains(TvCommandNames.Remove)
                ? removalRows
                : removalRows.Where(_ => false);
        }

        // Comando só tem dois resultados: a TV executou ou não. "Recusado por regra" não existe nesta trilha.
        if (query.Outcome is { } outcome)
        {
            commandRows = outcome switch
            {
                AuditOutcome.Success => commandRows.Where(r => r.Ok),
                AuditOutcome.Failure => commandRows.Where(r => !r.Ok),
                _ => commandRows.Where(r => false),
            };
            removalRows = outcome == AuditOutcome.Success ? removalRows : removalRows.Where(_ => false);
        }

        if (query.PersonId is { } person)
        {
            commandRows = commandRows.Where(r => r.UserId == person);
            removalRows = removalRows.Where(r => r.UserId == person);
        }

        if (query.After is { } cursor)
        {
            var at = cursor.OccurredAt;
            var id = cursor.Id;
            commandRows = cursor.TieFor(TvAuditNormalizer.Module) switch
            {
                AuditTie.SameSource => commandRows.Where(r => r.OccurredAt < at || (r.OccurredAt == at && r.Id.CompareTo(id) < 0)),
                AuditTie.IncludeSameInstant => commandRows.Where(r => r.OccurredAt <= at),
                _ => commandRows.Where(r => r.OccurredAt < at),
            };
            removalRows = cursor.TieFor(TvAuditNormalizer.Module) switch
            {
                AuditTie.SameSource => removalRows.Where(r => r.OccurredAt < at || (r.OccurredAt == at && r.Id.CompareTo(id) < 0)),
                AuditTie.IncludeSameInstant => removalRows.Where(r => r.OccurredAt <= at),
                _ => removalRows.Where(r => r.OccurredAt < at),
            };
        }

        var commands = await commandRows
            .OrderByDescending(r => r.OccurredAt)
            .ThenByDescending(r => r.Id)
            .Take(query.Limit)
            .ToListAsync(cancellationToken);
        var removals = await removalRows
            .OrderByDescending(r => r.OccurredAt)
            .ThenByDescending(r => r.Id)
            .Take(query.Limit)
            .ToListAsync(cancellationToken);

        return [.. commands.Select(TvAuditNormalizer.Normalize).Concat(removals.Select(TvAuditNormalizer.Normalize))
            .OrderByDescending(r => r.OccurredAt).ThenByDescending(r => r.Id).Take(query.Limit)];
    }
}
