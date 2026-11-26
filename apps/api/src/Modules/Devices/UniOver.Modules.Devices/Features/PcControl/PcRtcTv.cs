using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>A trilha da TV de um canal direto: nunca impede o canal nem a resposta (a trilha da TV só falha para o registro).</summary>
internal static class PcRtcTvTrail
{
    public static async Task RecordAsync(ITvDirectChannels tv, TvDirectUse use, CancellationToken cancellationToken)
    {
        try
        {
            await tv.RecordUseAsync(use, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // A trilha da TV é um efeito colateral: a falha dela não pode derrubar o canal.
        catch (Exception)
#pragma warning restore CA1031
        {
            // O Tv já registra a falha da própria trilha.
        }
    }
}

/// <summary>
/// O módulo TV avisa, pela outbox, que pessoas deixaram de poder controlar a TV de um computador (filiação retirada, TV apagada ou
/// computador trocado). Os canais delas com o escopo da TV fecham ou reabrem com o que sobrou, como na perda da permissão. A entrega é
/// "pelo menos uma vez": fechar o que já fechou não faz nada, e uma falha NÃO é engolida (a outbox repete). O que o agente não alcança
/// fica marcado e é refeito quando ele volta.
/// </summary>
internal sealed class TvDirectAccessRemovedHandler(PcRtcSessions sessions, PcRtcRevoker revoker) : IIntegrationEventHandler<TvDirectAccessRemoved>
{
    public async Task HandleAsync(TvDirectAccessRemoved integrationEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);

        var plan = PlanFor(sessions, integrationEvent);
        if (plan.Count > 0)
        {
            await revoker.CloseAsync(plan, cancellationToken);
        }
    }

    /// <summary>
    /// A folga entre o instante do aviso e a abertura de um canal para ele ser poupado. O aviso registra o instante ANTES do commit da
    /// retirada, e uma oferta que leu a visibilidade antiga um instante antes do commit abre o canal DEPOIS desse instante: poupá-la ao
    /// pé da letra deixaria passar um canal sem direito. Só se poupa o que abriu bem depois. O caso retirar e readicionar em menos de
    /// um minuto fecha também o canal novo, o que só custa disponibilidade do canal direto (a TV segue pela nuvem).
    /// </summary>
    internal static readonly TimeSpan ReopenGrace = TimeSpan.FromSeconds(60);

    /// <summary>
    /// O que fechar: as sessões do computador com o escopo da TV, das pessoas do aviso, exceto as abertas bem depois do aviso
    /// (<see cref="ReopenGrace"/>). O aviso pode chegar tarde (a outbox repete); se a pessoa foi retirada e readicionada antes da
    /// entrega, o canal que ela abriu muito depois da retirada é legítimo e não leva <c>revoked</c>. Aviso sem instante (<c>default</c>,
    /// como um gravado antes de o campo existir) fecha tudo, como sempre fechou.
    /// </summary>
    internal static List<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)> PlanFor(PcRtcSessions sessions, TvDirectAccessRemoved integrationEvent)
    {
        ArgumentNullException.ThrowIfNull(sessions);
        ArgumentNullException.ThrowIfNull(integrationEvent);

        var hasInstant = integrationEvent.OccurredAt != default;
        return sessions.ForAgent(integrationEvent.AgentSlug)
            .Where(session => session.Scopes.HasFlag(PcRtcScopes.Tv)
                && (integrationEvent.UserIds is null || integrationEvent.UserIds.Contains(session.UserId))
                && (!hasInstant || session.OpenedAt <= integrationEvent.OccurredAt + ReopenGrace))
            .Select(session => (session, session.Scopes.HasFlag(PcRtcScopes.Pc) ? PcRtcCloseV1BodyReason.Rescoped : PcRtcCloseV1BodyReason.Revoked))
            .ToList();
    }
}
