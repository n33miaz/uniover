using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>O canal que o agente diz ter aberto (<c>pc.rtc.reconcile.v1</c>): só o id e o bilhete que a API deu; o resto o bilhete diz.</summary>
internal sealed record PcRtcClaim(Guid SessionId, string Ticket);

/// <summary>O que o reconciliador precisa saber de fora do registro: o agente da conexão e o direito de cada escopo agora.</summary>
internal interface IPcRtcReconcileAuthority
{
    /// <summary>O agente pelo nome, com o que ele declarou no <c>hello</c> desta conexão; nulo se revogado ou desconhecido.</summary>
    Task<PcTarget?> AgentAsync(string slug, CancellationToken cancellationToken);

    /// <summary>O subconjunto de <paramref name="scopes"/> que ainda vale para a pessoa neste agente (a regra única da oferta).</summary>
    Task<PcRtcScopes> ValidScopesAsync(Guid userId, PcRtcScopes scopes, Guid? tvId, string agentSlug, CancellationToken cancellationToken);
}

internal sealed class PcRtcReconcileAuthority(
    PcAgentResolver resolver, IAccessGrants grants, IAccountRoleDirectory? roles = null, ITvDirectChannels? tv = null) : IPcRtcReconcileAuthority
{
    public Task<PcTarget?> AgentAsync(string slug, CancellationToken cancellationToken) => resolver.ResolveBySlugAsync(slug, cancellationToken);

    public async Task<PcRtcScopes> ValidScopesAsync(
        Guid userId, PcRtcScopes scopes, Guid? tvId, string agentSlug, CancellationToken cancellationToken)
    {
        var owner = roles is not null && (await roles.OwnersAmongAsync([userId], cancellationToken)).Contains(userId);
        return await PcRtcRights.StillValidAsync(resolver, grants, tv, userId, owner, scopes, tvId, agentSlug, cancellationToken);
    }
}

/// <summary>
/// O agente reconectou e diz ter um canal direto aberto: a API pode ter reiniciado e perdido o registro dele, e sem o registro uma
/// revogação não acharia o canal (ele viveria até a vida máxima). NADA do que o agente declara é confiado: ele devolve o bilhete que a API
/// assinou na oferta. A sessão só é reconstruída se o bilhete é dela e não venceu, é deste agente (o da conexão) e desta sessão, e se a sessão
/// de login que abriu o canal ainda existe e não foi revogada; então se reconferem as permissões pelas regras da oferta. O que continua
/// valendo é confirmado ao agente (<c>pc.rtc.reconciled.v1</c>); o resto é fechado com <c>revoked</c> (nada sobrou) ou <c>rescoped</c> (sobrou
/// um escopo, e o app abre outro). As lápides em memória são só um reforço: a segurança está no bilhete e na sessão de login. Uma conexão que
/// não declarou a capacidade é ignorada. Falhando no meio, a confirmação não sai e o agente fecha o canal pelo prazo dele.
/// </summary>
internal sealed partial class PcRtcReconciler(
    IPcRtcReconcileAuthority authority,
    ISessionFamilyDirectory families,
    IAgentGateway gateway,
    PcRtcSessions sessions,
    IPcRtcCloser closer,
    PcRtcTickets tickets,
    PcDeviceStates deviceStates,
    TimeProvider time,
    ILogger<PcRtcReconciler> logger)
{
    public async Task ReconcileAsync(string agentSlug, IReadOnlyList<PcRtcClaim> claims, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(claims);

        if (claims.Count == 0 || await authority.AgentAsync(agentSlug, cancellationToken) is not { Connected: true } agent)
        {
            return;
        }

        // Só quem declarou a capacidade no `hello` desta conexão reconcilia: um agente anterior (ou um token de agente que a API não conhece
        // assim) nunca tem canal reconstruído por aqui.
        if (!agent.Capabilities.Contains(PcMessages.RtcReconcileCapability, StringComparer.Ordinal))
        {
            LogIgnored();
            return;
        }

        var close = new List<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)>();
        var kept = new List<PcRtcSession>();
        foreach (var claim in claims)
        {
            var now = time.GetUtcNow();
            var ticket = tickets.Read(claim.Ticket, now);
            if (ticket is null
                || ticket.SessionId != claim.SessionId
                || !string.Equals(ticket.AgentSlug, agentSlug, StringComparison.Ordinal))
            {
                // Adulterado, vencido, de outra sessão ou de outro agente: não é prova de nada. A pessoa do bilhete (se houver) nem é consultada.
                LogRefused();
                close.Add((new PcRtcSession(claim.SessionId, ticket?.UserId ?? Guid.Empty, agent.AgentId, agentSlug, now), PcRtcCloseV1BodyReason.Revoked));
                continue;
            }

            var claimed = new PcRtcSession(
                ticket.SessionId, ticket.UserId, agent.AgentId, agentSlug, ticket.IssuedAt < now ? ticket.IssuedAt : now, ticket.Family, false, ticket.Scopes, ticket.TvId, NegotiatedUntil: ticket.ExpiresAt - PcRtcSessions.TokenLifetime);
            var restore = sessions.Restore(claimed);
            if (restore.Outcome is PcRtcRestoreOutcome.Closed or PcRtcRestoreOutcome.Replaced)
            {
                close.Add((claimed, restore.Outcome == PcRtcRestoreOutcome.Closed ? PcRtcCloseV1BodyReason.Revoked : PcRtcCloseV1BodyReason.Replaced));
                continue;
            }

            // Já no registro (a revogação que chegar agora a encontra), confere de novo, com a regra da oferta.
            var session = restore.Session!;
            var valid = PcRtcScopes.None;
            if (ticket.Family is { } family && await families.IsActiveAsync(session.UserId, family, cancellationToken))
            {
                valid = await authority.ValidScopesAsync(session.UserId, session.Scopes, session.TvId, agentSlug, cancellationToken);
                // O aparelho que o dono do PC recusou (ou ainda não aprovou) não leva o PC, como na oferta.
                if (valid.HasFlag(PcRtcScopes.Pc) && ticket.DeviceId is not null && deviceStates.RefusalFor(agentSlug, ticket.DeviceId) is not null)
                {
                    valid &= ~PcRtcScopes.Pc;
                }
            }

            if (CloseReasonFor(session.Scopes, valid) is { } reason)
            {
                close.Add((session, reason));
            }
            else
            {
                kept.Add(session);
            }
        }

        if (close.Count > 0)
        {
            await closer.CloseAsync(close, cancellationToken);
        }

        // As conferências têm awaits: uma revogação pode ter tirado a sessão (ou a marcado) desde que ela foi reconstruída. Só se confirma o que
        // AINDA está lá e limpo, conferido sob o trinco do registro imediatamente antes de cada confirmação.
        var confirmed = 0;
        var late = new List<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)>();
        foreach (var session in kept)
        {
            if (!sessions.IsLiveAndClean(session.Id, session.UserId))
            {
                late.Add((session, PcRtcCloseV1BodyReason.Revoked));
                continue;
            }

            await gateway.SendAsync(agentSlug, PcMessages.RtcReconciled(session.Id), cancellationToken);
            confirmed++;
        }

        if (late.Count > 0)
        {
            await closer.CloseAsync(late, cancellationToken);
        }

        LogReconciled(confirmed, close.Count + late.Count);
    }

    /// <summary>
    /// O que fazer com um canal que pedia <paramref name="scopes"/> e agora só tem direito a <paramref name="valid"/>: nada (nulo, tudo de pé),
    /// <c>rescoped</c> (sobrou um escopo, e o app abre outro com ele) ou <c>revoked</c> (nada sobrou). A mesma regra do ouvinte de acesso.
    /// </summary>
    internal static PcRtcCloseV1BodyReason? CloseReasonFor(PcRtcScopes scopes, PcRtcScopes valid) =>
        (valid & scopes) == scopes
            ? null
            : (valid & scopes) == PcRtcScopes.None ? PcRtcCloseV1BodyReason.Revoked : PcRtcCloseV1BodyReason.Rescoped;

    [LoggerMessage(Level = LogLevel.Information, Message = "Canais diretos reconciliados depois da reconexão do agente: {Confirmed} confirmados, {Closed} fechados.")]
    private partial void LogReconciled(int confirmed, int closed);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Reconciliação do canal direto ignorada: a conexão do agente não declarou pc.rtc.reconcile.v1.")]
    private partial void LogIgnored();

    [LoggerMessage(Level = LogLevel.Warning, Message = "Reconciliação do canal direto recusada: bilhete adulterado, vencido, de outra sessão ou de outro agente.")]
    private partial void LogRefused();
}
