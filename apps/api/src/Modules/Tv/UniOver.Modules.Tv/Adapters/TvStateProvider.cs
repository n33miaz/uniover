using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// O estado da TV como a tela o enxerga: a última leitura do agente combinada com a presença dele. A presença é
/// consultada na hora (só em memória), então "agente fora do ar" nunca precisa de escrita no banco. O agente é o que o
/// resolvedor entrega (o salvo no app ou a variável de reserva).
/// </summary>
internal sealed class TvStateProvider(
    ITvAgentResolver agents, ITvStateStore state, ITvAgentPresence presence, ITvStreamPublisher stream)
{
    public async ValueTask<TvState> CurrentAsync(CancellationToken cancellationToken)
    {
        var binding = await agents.ResolveAsync(cancellationToken);
        return Current(binding);
    }

    /// <summary>O estado do agente já resolvido (quem acabou de salvar o troca sem esperar o cache).</summary>
    public TvState Current(TvAgentBinding binding)
    {
        ArgumentNullException.ThrowIfNull(binding);

        if (!binding.IsConfigured)
        {
            return TvState.From(null, agentOnline: false);
        }

        var agentId = binding.AgentSlug!;
        var online = presence.IsOnline(agentId);
        var view = TvState.From(state.Last(agentId), online);

        // Quem lê descobre a mudança antes de qualquer comando: avisa a tela agora, para o aviso não se perder
        // (um comando que falhar depois já a encontraria anotada e não avisaria de novo).
        if (state.NoteOnline(agentId, online))
        {
            stream.PublishState(view);
        }

        return view;
    }
}
