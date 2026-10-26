using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Tv.Audit;

internal static class TvAuditNormalizer
{
    public const string Module = "tv";

    /// <summary>Todo comando que a trilha de comandos registra, na ordem em que a tela os lista.</summary>
    public static IReadOnlyList<string> Actions { get; } =
    [
        TvCommandNames.Key,
        TvCommandNames.Text,
        TvCommandNames.AppLaunch,
        TvCommandNames.Wake,
        TvCommandNames.PowerOff,
        TvCommandNames.PowerSchedule,
        TvCommandNames.Cleanup,
        TvCommandNames.AppsRefresh,
        TvCommandNames.ShortcutsReorder,
        TvCommandNames.ShortcutUpdate,
        TvCommandNames.ConfigBind,
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
}

/// <summary>Lê <c>command_audit</c> como uma fonte da trilha unificada: só leitura, com o papel da aplicação.</summary>
internal sealed class TvAuditSource(TvDbContext db) : IAuditSource
{
    public AuditSourceInfo Info { get; } = new(
        TvAuditNormalizer.Module, AuditRetentionPolicy.CommandDays, TvAuditNormalizer.Actions);

    public async Task<IReadOnlyList<AuditRecord>> ReadAsync(AuditQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        IQueryable<CommandAuditEntry> rows = db.CommandAudit.AsNoTracking();

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
            var wanted = actions.ToArray();
            rows = rows.Where(r => wanted.Contains(r.Command));
        }

        // Comando só tem dois resultados: a TV executou ou não. "Recusado por regra" não existe nesta trilha.
        if (query.Outcome is { } outcome)
        {
            rows = outcome switch
            {
                AuditOutcome.Success => rows.Where(r => r.Ok),
                AuditOutcome.Failure => rows.Where(r => !r.Ok),
                _ => rows.Where(r => false),
            };
        }

        if (query.PersonId is { } person)
        {
            rows = rows.Where(r => r.UserId == person);
        }

        if (query.After is { } cursor)
        {
            var at = cursor.OccurredAt;
            var id = cursor.Id;
            rows = cursor.TieFor(TvAuditNormalizer.Module) switch
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

        return [.. found.Select(TvAuditNormalizer.Normalize)];
    }
}
