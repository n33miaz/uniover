using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Assina a presença do Devices: quando o agente que controla a TV conecta ou cai, a tela é avisada na hora, sem
/// leitura nem comando e sem escrita no banco. Roda dentro da conexão do agente, então só atualiza memória e enfileira.
/// </summary>
internal sealed class TvPresenceListener(IOptions<TvModuleOptions> options, ITvStateStore state, ITvStreamPublisher stream)
    : IAgentPresenceListener
{
    public void OnPresenceChanged(AgentPresenceInfo info)
    {
        ArgumentNullException.ThrowIfNull(info);

        var configured = options.Value.AgentId;
        if (string.IsNullOrWhiteSpace(configured) || !string.Equals(configured, info.AgentId, StringComparison.Ordinal))
        {
            return;
        }

        if (state.NoteOnline(info.AgentId, info.Connected))
        {
            stream.PublishState(TvState.From(state.Last(info.AgentId), info.Connected));
        }
    }
}
