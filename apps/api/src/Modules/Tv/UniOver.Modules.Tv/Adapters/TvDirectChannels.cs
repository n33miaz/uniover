using System.Text.RegularExpressions;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// A porta do módulo TV para o canal direto (<see cref="ITvDirectChannels"/>). Quem pode levar teclas e texto de uma TV pelo canal é
/// quem poderia mandá-los pela nuvem: a mesma permissão (<c>tv:control</c>, lida do banco com cache curto, nunca do JWT) e a mesma
/// regra de visibilidade de TV por conta (<see cref="TvSelectionService"/>). Falha fechada: sem poder consultar, nada é concedido.
/// </summary>
internal sealed partial class TvDirectChannels(
    IAccessGrants grants, TvSelectionService selection, QueuedCommandAudit audit, TimeProvider time) : ITvDirectChannels
{
    public async Task<TvDirectTarget?> ResolveAsync(Guid userId, bool isOwner, Guid? tvId, CancellationToken cancellationToken = default)
    {
        if (!await grants.HasAsync(userId, AccessPermissions.TvModule, cancellationToken)
            || !await grants.HasAsync(userId, AccessPermissions.TvControl, cancellationToken))
        {
            return null;
        }

        var target = await selection.ResolveAsync(userId, isOwner, tvId, cancellationToken);

        // A TV padrão ainda sem linha salva (o contrato antigo) não tem id para a trilha nem filiação a conferir: segue pela nuvem.
        return target is { IsPersisted: true } && !string.IsNullOrWhiteSpace(target.AgentSlug)
            ? new TvDirectTarget(target.Id, target.AgentSlug)
            : null;
    }

    public async Task RecordUseAsync(TvDirectUse use, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(use);

        var client = new ClientInfo(use.Ip, use.UserAgent);
        var now = time.GetUtcNow();
        if (string.Equals(use.Reason, TvDirectUseReasons.Opened, StringComparison.Ordinal))
        {
            await audit.RecordAsync(
                CommandAuditEntry.Create(use.UserId, use.AgentSlug, TvCommandNames.Key, "via=direct opened", ok: true, errorCode: null, latencyMs: null, client, now, use.TvId),
                cancellationToken);
            return;
        }

        // Só o motivo do contrato (letras e `_`): o que veio do agente nunca entra na trilha como texto livre.
        var reason = ReasonPattern().IsMatch(use.Reason) ? use.Reason : "closed";
        if (use.Keys > 0)
        {
            await audit.RecordAsync(
                CommandAuditEntry.Create(use.UserId, use.AgentSlug, TvCommandNames.Key, $"via=direct count={use.Keys} reason={reason}", ok: true, errorCode: null, latencyMs: null, client, now, use.TvId),
                cancellationToken);
        }

        // Do texto, só quantos pedidos (nunca o conteúdo, que pode ser uma senha, nem o tamanho).
        if (use.Texts > 0)
        {
            await audit.RecordAsync(
                CommandAuditEntry.Create(use.UserId, use.AgentSlug, TvCommandNames.Text, $"via=direct count={use.Texts} reason={reason}", ok: true, errorCode: null, latencyMs: null, client, now, use.TvId),
                cancellationToken);
        }
    }

    [GeneratedRegex("^[a-z_]{1,20}$", RegexOptions.CultureInvariant)]
    private static partial Regex ReasonPattern();
}
