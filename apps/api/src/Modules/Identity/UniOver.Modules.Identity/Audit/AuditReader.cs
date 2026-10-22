using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Persistence;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Identity.Audit;

/// <summary>Os filtros de uma consulta à trilha, já conferidos. Tudo opcional; combinam com E.</summary>
/// <param name="Modules">Só estas fontes; vazio = todas.</param>
/// <param name="Actions">Só estes códigos de ação; vazio = todos.</param>
internal sealed record AuditFilter(
    DateTimeOffset? From,
    DateTimeOffset? To,
    Guid? PersonId,
    IReadOnlyList<string> Modules,
    IReadOnlyList<string> Actions,
    AuditOutcome? Outcome);

/// <summary>Conta citada numa linha. <c>DisplayName</c> nulo = conta apagada ou desconhecida (o id continua útil).</summary>
internal sealed record AuditAccount(Guid Id, string? DisplayName);

/// <summary>
/// Uma linha da trilha como o administrador a lê. Traz IP e aparelho (só o administrador chega aqui) e NUNCA e-mail,
/// senha, token nem texto digitado na TV. As contas vêm pelo id e pelo nome de exibição ATUAL.
/// </summary>
/// <param name="Module"><c>identity</c>, <c>devices</c> ou <c>tv</c>.</param>
/// <param name="Outcome"><c>success</c>, <c>failure</c> ou <c>denied</c>.</param>
/// <param name="Actor">Quem agiu; nulo quando ninguém estava autenticado (a tela mostra "alguém sem login").</param>
/// <param name="TargetAccount">A conta sobre a qual se agiu, quando é outra pessoa, ou contra a qual alguém sem login tentou entrar.</param>
internal sealed record AuditItem(
    Guid Id,
    string Module,
    string Action,
    string Outcome,
    DateTimeOffset OccurredAt,
    AuditAccount? Actor,
    string? Target,
    AuditAccount? TargetAccount,
    string? Detail,
    string? Ip,
    string? UserAgent);

/// <param name="NextCursor">Passe em <c>cursor</c> para a página seguinte; nulo na última.</param>
internal sealed record AuditPage(IReadOnlyList<AuditItem> Items, string? NextCursor);

/// <summary>Uma fonte da trilha: o módulo, quantos dias guarda e os códigos de ação que pode registrar.</summary>
internal sealed record AuditSourceSummary(string Module, int RetentionDays, IReadOnlyList<string> Actions);

/// <summary>As fontes e os resultados possíveis: o que a tela precisa para montar os filtros sem repetir listas.</summary>
internal sealed record AuditSourcesResponse(IReadOnlyList<AuditSourceSummary> Sources, IReadOnlyList<string> Outcomes);

/// <summary>
/// Junta as fontes de auditoria de todos os módulos numa trilha só, em tempo de leitura (os volumes são pequenos):
/// cada fonte devolve a sua página já filtrada, e a junção ordena por (instante, fonte, id). Mora no Identity porque as
/// regras de arquitetura permitem (módulo só enxerga portas, aqui o <see cref="IAuditSource"/> do SharedKernel) e porque
/// as contas, para traduzir id em nome, são dele.
/// </summary>
internal sealed class AuditReader(IEnumerable<IAuditSource> sources, IdentityDbContext db)
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 200;

    /// <summary>Teto de linhas de uma exportação: pedidos maiores são cortados e avisados, nunca estouram a memória.</summary>
    public const int ExportMaxRows = 5000;

    public AuditSourcesResponse DescribeSources() => new(
        [.. sources
            .Select(s => s.Info)
            .OrderBy(i => i.Module, StringComparer.Ordinal)
            .Select(i => new AuditSourceSummary(i.Module, i.RetentionDays, i.Actions))],
        AuditOutcomes.All);

    /// <summary>Os nomes de fonte aceitos no filtro <c>module</c>.</summary>
    public IReadOnlyList<string> KnownModules => [.. sources.Select(s => s.Info.Module).Order(StringComparer.Ordinal)];

    public async Task<AuditPage> ReadPageAsync(
        AuditFilter filter, int limit, AuditCursor? after, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(filter);

        // Uma linha a mais por fonte: se a junção tem mais que `limit`, existe próxima página (e as `limit` primeiras são
        // exatas, porque o topo da junção sai do topo de cada fonte).
        var query = new AuditQuery(limit + 1, filter.From, filter.To, filter.PersonId, filter.Actions, filter.Outcome, after);

        var merged = new List<AuditRecord>();
        foreach (var source in Selected(filter))
        {
            merged.AddRange(await source.ReadAsync(query, cancellationToken));
        }

        merged.Sort(AuditOrder.Newest);
        var hasMore = merged.Count > limit;
        var page = hasMore ? merged.GetRange(0, limit) : merged;

        var names = await NamesAsync(page, cancellationToken);
        var items = page.Select(r => ToItem(r, names)).ToList();
        return new AuditPage(items, hasMore ? AuditCursor.Of(page[^1]).Encode() : null);
    }

    private IEnumerable<IAuditSource> Selected(AuditFilter filter) =>
        sources.Where(s =>
            (filter.Modules.Count == 0 || filter.Modules.Contains(s.Info.Module, StringComparer.Ordinal))

            // Pedir só ações que esta fonte nem sabe registrar não vale uma consulta.
            && (filter.Actions.Count == 0 || filter.Actions.Any(a => s.Info.Actions.Contains(a, StringComparer.Ordinal))));

    /// <summary>Nome de exibição atual de cada conta citada na página. Conta que não existe mais fica de fora do mapa.</summary>
    private async Task<Dictionary<Guid, string>> NamesAsync(List<AuditRecord> page, CancellationToken cancellationToken)
    {
        var ids = page
            .SelectMany(r => new[] { r.ActorId, r.TargetUserId })
            .OfType<Guid>()
            .Distinct()
            .ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<Guid, string>();
        }

        // Só id e nome: o e-mail nunca é lido por este caminho.
        return await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName })
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName, cancellationToken);
    }

    private static AuditItem ToItem(AuditRecord record, Dictionary<Guid, string> names) => new(
        record.Id,
        record.Module,
        record.Action,
        AuditOutcomes.ToCode(record.Outcome),
        record.OccurredAt,
        Account(record.ActorId, names),
        record.Target,
        Account(record.TargetUserId, names),
        record.Detail,
        record.Ip,
        record.UserAgent);

    private static AuditAccount? Account(Guid? id, Dictionary<Guid, string> names) =>
        id is { } value ? new AuditAccount(value, names.GetValueOrDefault(value)) : null;
}
