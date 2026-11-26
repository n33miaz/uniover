using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>Registra na trilha o fechamento do canal que o agente avisou (a sessão sai da memória uma vez só).</summary>
internal sealed class PcRtcClosures(
    PcRtcSessions sessions, PairingAuditWriter audit, DevicesDbContext db, IAgentGateway gateway, ITvDirectChannels? tv = null)
{
    /// <summary>
    /// O agente voltou: refaz o fechamento "revogado" das sessões cujo aviso não o alcançou na queda. Só sai do registro o que o aviso de
    /// fato alcançou; o que falhar de novo segue marcado para a próxima volta.
    /// </summary>
    public async Task RetryRevocationsAsync(string agentSlug, CancellationToken cancellationToken)
    {
        var closed = 0;
        foreach (var session in sessions.RevokePendingForAgent(agentSlug))
        {
            var sent = await gateway.SendAsync(agentSlug, PcMessages.RtcClose(session.Id, PcRtcCloseV1BodyReason.Revoked), cancellationToken);
            if (sent.IsSuccess && sessions.TakeOwned(session.Id, session.UserId) is not null)
            {
                audit.Add(PcRtcAudit.ClosedEvent(session), new ClientInfo(null, null), agentId: session.AgentId, userId: session.UserId);
                closed++;
            }
        }

        if (closed > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    /// <summary>
    /// O agente avisou que o canal fechou. Se a sessão ainda estava no registro, grava o fechamento. Se levava a TV, o agente manda também
    /// a soma de teclas e textos, e ela vai para a trilha da TV (mesmo quando foi a API que mandou fechar, e a sessão já saiu daqui).
    /// </summary>
    public async Task AgentClosedAsync(
        string agentSlug, Guid sessionId, string? reason, int? tvKeys, int? tvTexts, CancellationToken cancellationToken)
    {
        var live = sessions.TakeForAgent(agentSlug, sessionId);
        var session = live ?? sessions.TakeClosedTv(agentSlug, sessionId);
        if (session is null)
        {
            return;
        }

        if (live is not null)
        {
            audit.Add(PcRtcAudit.ClosedEvent(session), new ClientInfo(null, null), agentId: session.AgentId, userId: session.UserId);
            await db.SaveChangesAsync(cancellationToken);
        }

        if (session.TvId is { } tvId && tv is not null && tvKeys is not null && tvTexts is not null)
        {
            await PcRtcTvTrail.RecordAsync(
                tv, new TvDirectUse(session.UserId, tvId, session.AgentSlug, tvKeys.Value, tvTexts.Value, reason ?? "closed", null, null), cancellationToken);
        }
    }
}

/// <summary>
/// Fecha, ao ver que a pessoa perdeu um escopo do canal (ou o acesso todo), as sessões que o plano manda: a que ficou sem nada
/// recebe <c>revoked</c> e a que ficou com um escopo recebe <c>rescoped</c> (o app abre outro já, com o que sobrou). Só sai do registro o
/// que o aviso de fato alcançou; o que não alcançou fica marcado e é refeito quando o agente volta.
/// </summary>
internal sealed partial class PcRtcRevoker(
    PcRtcSessions sessions,
    IAgentGateway gateway,
    PairingAuditWriter audit,
    DevicesDbContext db,
    ILogger<PcRtcRevoker> logger) : IPcRtcCloser
{
    /// <summary>Nunca propaga falha: a mudança de acesso já vale, e o que não fechar agora fecha pela vida máxima do canal.</summary>
    public async Task CloseSafelyAsync(IReadOnlyList<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)> plan, string what)
    {
        try
        {
            using var timeout = new CancellationTokenSource(PcRtcAccessListener.Timeout);
            await CloseAsync(plan, timeout.Token);
        }
#pragma warning disable CA1031 // A mudança de acesso já vale: a falha daqui só vai para o registro.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogCloseFailed(what, ex.GetType().Name);
        }
    }

    public async Task CloseAsync(IReadOnlyList<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)> plan, CancellationToken cancellationToken)
    {
        var closed = 0;
        try
        {
            foreach (var (session, reason) in plan)
            {
                // Só sai do registro o que o aviso de fato alcançou: sem alcançar o agente (offline, queda), a sessão fica e uma
                // próxima mudança, o aviso dele ou a vida máxima do canal a encerram.
                if (!await TrySendCloseAsync(session, reason, cancellationToken))
                {
                    // O agente não foi alcançado: a sessão fica marcada e a revogação é refeita quando ele voltar (ele pode manter o canal
                    // direto por alguns segundos sem a API, e este é o que impede um canal revogado de viver até a vida máxima).
                    sessions.MarkRevokePending(session.Id, session.AgentSlug);
                    continue;
                }

                if (sessions.TakeOwned(session.Id, session.UserId) is null)
                {
                    continue;
                }

                audit.Add(PcRtcAudit.ClosedEvent(session), new ClientInfo(null, null), agentId: session.AgentId, userId: session.UserId);
                closed++;
            }
        }
        finally
        {
            if (closed > 0)
            {
                // O que já saiu do registro tem a trilha gravada mesmo que o resto tenha estourado o prazo.
                using var saving = new CancellationTokenSource(PcRtcAccessListener.Timeout);
                await db.SaveChangesAsync(saving.Token);
            }
        }
    }

    /// <summary>Manda o fechamento ao agente da sessão; <c>false</c> se ele não foi alcançado (offline, queda ou falha da entrega). Uma sessão não derruba as outras.</summary>
    private async Task<bool> TrySendCloseAsync(PcRtcSession session, PcRtcCloseV1BodyReason reason, CancellationToken cancellationToken)
    {
        try
        {
            var sent = await gateway.SendAsync(session.AgentSlug, PcMessages.RtcClose(session.Id, reason), cancellationToken);
            return sent.IsSuccess;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // O aviso a um agente não pode impedir o dos outros: o canal que ficou fecha pela vida máxima dele.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogSendFailed(ex.GetType().Name);
            return false;
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "O fechamento dos canais diretos do PC falhou ({Kind}, {Error}).")]
    private partial void LogCloseFailed(string kind, string error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "O aviso de fechamento do canal direto não saiu ({Error}).")]
    private partial void LogSendFailed(string error);
}

/// <summary>
/// O canal direto não passa pela API a cada comando, então não perceberia sozinho que a pessoa deixou de poder usá-lo. Aqui ele
/// fecha na hora quando a sessão que o abriu acaba (sair, "sair de todos", senha trocada ou recuperada, aparelho revogado), a
/// conta é pausada ou revogada, ou uma permissão que ele usa é retirada: o módulo do PC (o escopo <c>pc</c>), o da TV ou o controle
/// da TV (o escopo <c>tv</c>). Perder um escopo e manter o outro REABRE o canal só com o que sobrou (<c>rescoped</c>); perder o último fecha
/// (<c>revoked</c>). O agente solta o que o PC segurava, e a trilha grava o fechamento. Em processo, como os caches de permissão do
/// Identity; um canal de outra instância vale em até a vida máxima dele.
/// </summary>
internal sealed class PcRtcAccessListener(PcRtcSessions sessions, PcRtcRevoker revoker) : IUserAccessListener
{
    /// <summary>O prazo do ouvinte inteiro (e de cada gravação): a mudança de acesso já está gravada e ninguém mais espera por ele.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public async Task ChangedAsync(UserAccessChange change, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(change);

        var plan = sessions.FindWhere(change.UserId, session => ReasonFor(change, session) is not null)
            .Select(session => (session, ReasonFor(change, session)!.Value))
            .ToList();
        if (plan.Count > 0)
        {
            await revoker.CloseSafelyAsync(plan, change.Kind.ToString());
        }
    }

    /// <summary>O motivo de fechar a sessão com esta mudança, ou nulo se ela não a afeta.</summary>
    internal static PcRtcCloseV1BodyReason? ReasonFor(UserAccessChange change, PcRtcSession session) => change.Kind switch
    {
        UserAccessChangeKind.SessionEnded => session.SessionFamily == change.SessionId ? PcRtcCloseV1BodyReason.Revoked : null,
        UserAccessChangeKind.SessionsEnded => change.SessionId is null || session.SessionFamily != change.SessionId
            ? PcRtcCloseV1BodyReason.Revoked
            : null,
        UserAccessChangeKind.AccountDisabled => PcRtcCloseV1BodyReason.Revoked,
        UserAccessChangeKind.ModuleRemoved => ReasonForLost(session, change.Module switch
        {
            AccessPermissions.PcModule => PcRtcScopes.Pc | PcRtcScopes.Screen,
            AccessPermissions.TvModule => PcRtcScopes.Tv,
            _ => PcRtcScopes.None,
        }),
        UserAccessChangeKind.PermissionRemoved => ReasonForLost(session, change.Permission switch
        {
            AccessPermissions.TvControl => PcRtcScopes.Tv,
            AccessPermissions.PcScreen => PcRtcScopes.Screen,
            _ => PcRtcScopes.None,
        }),
        _ => null,
    };

    /// <summary>Sem nada do que se perdeu, a sessão fica; sem nada do que sobrou, fecha; com algo, reabre com o que sobrou.</summary>
    private static PcRtcCloseV1BodyReason? ReasonForLost(PcRtcSession session, PcRtcScopes lost)
    {
        if (lost == PcRtcScopes.None || (session.Scopes & lost) == PcRtcScopes.None)
        {
            return null;
        }

        return (session.Scopes & ~lost) == PcRtcScopes.None ? PcRtcCloseV1BodyReason.Revoked : PcRtcCloseV1BodyReason.Rescoped;
    }
}

/// <summary>Quem fecha as sessões de um plano (avisa o agente, tira do registro e grava a trilha): o <see cref="PcRtcRevoker"/>.</summary>
internal interface IPcRtcCloser
{
    Task CloseAsync(IReadOnlyList<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)> plan, CancellationToken cancellationToken);
}
