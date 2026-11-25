using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// O estado da TV como a tela o enxerga: a última leitura do agente combinada com a presença dele. A presença é
/// consultada na hora (só em memória), então "agente fora do ar" nunca precisa de escrita no banco. O agente é o da
/// TV já escolhida pela regra de visibilidade da requisição.
/// </summary>
internal sealed class TvStateProvider(
    ITvCurrentSelection selection, ITvStateStore state, ITvAgentPresence presence,
    IOptions<TvModuleOptions> options, TvLinkWatcher watcher)
{
    public async ValueTask<TvState> CurrentAsync(CancellationToken cancellationToken)
    {
        return Current(selection.Current);
    }

    /// <summary>O estado do agente já resolvido (quem acabou de salvar o troca sem esperar o cache).</summary>
    public TvState Current(TvTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        var agentId = target.AgentSlug;
        var online = presence.IsOnline(agentId);
        var view = TvState.From(state.Last(agentId), online, !string.IsNullOrWhiteSpace(agentId), presence.OfflineSince(agentId),
            presence.HasRecentReport(agentId, options.Value.LinkStale));

        // Quem lê descobre a mudança antes de qualquer comando: avisa a tela agora, para o aviso não se perder
        // (um comando que falhar depois já a encontraria anotada e não avisaria de novo).
        if (state.NoteOnline(agentId, online))
        {
            // Pela vigia: publicação e linha de base na mesma região crítica, para a próxima passada comparar com o que o fluxo mostra.
            watcher.Publish(target.Id, agentId, view);
        }

        // O elo também muda só com o tempo: a vigia passa a conhecer esta TV e o elo que a tela acabou de ver.
        watcher.Track(target.Id, agentId, view);

        return view;
    }
}
