using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// O estado da TV como a tela o enxerga: a última leitura do agente combinada com a presença dele. A presença é
/// consultada na hora (só em memória), então "agente fora do ar" nunca precisa de escrita no banco.
/// </summary>
internal sealed class TvStateProvider(
    IOptions<TvModuleOptions> options, ITvStateStore state, ITvAgentPresence presence, ITvStreamPublisher stream)
{
    public TvState Current()
    {
        var agentId = options.Value.AgentId;
        if (string.IsNullOrWhiteSpace(agentId))
        {
            return TvState.From(null, agentOnline: false);
        }

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
