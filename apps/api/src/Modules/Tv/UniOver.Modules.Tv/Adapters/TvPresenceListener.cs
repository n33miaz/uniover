using Microsoft.Extensions.Logging;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Assina a presença do Devices: quando o agente que controla a TV conecta ou cai, a tela é avisada na hora, sem
/// leitura nem comando e sem escrita no banco. Roda dentro da conexão do agente, então só atualiza memória e enfileira:
/// com o último valor do resolvedor em mãos decide ali mesmo; só na primeira vez depois de subir (sem valor ainda) a
/// decisão espera a leitura numa tarefa à parte, sem segurar a conexão.
/// </summary>
internal sealed partial class TvPresenceListener(
    ITvAgentResolver agents, ITvStateStore state, ITvStreamPublisher stream, ILogger<TvPresenceListener> logger)
    : IAgentPresenceListener
{
    public void OnPresenceChanged(AgentPresenceInfo info)
    {
        ArgumentNullException.ThrowIfNull(info);

        if (agents.TryGetLast(out var binding))
        {
            Apply(binding, info);
            return;
        }

        _ = ApplyAfterReadAsync(info);
    }

    private async Task ApplyAfterReadAsync(AgentPresenceInfo info)
    {
        try
        {
            Apply(await agents.ResolveAsync(CancellationToken.None), info);
        }
#pragma warning disable CA1031 // Fora da conexão do agente ninguém trata o erro: um aviso perdido não pode derrubar o processo.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogResolveFailed(ex.GetType().Name);
        }
    }

    private void Apply(TvAgentBinding binding, AgentPresenceInfo info)
    {
        if (!binding.IsConfigured || !string.Equals(binding.AgentSlug, info.AgentId, StringComparison.Ordinal))
        {
            return;
        }

        if (state.NoteOnline(info.AgentId, info.Connected))
        {
            stream.PublishState(TvState.From(state.Last(info.AgentId), info.Connected));
        }
    }

    // Só o tipo do erro: a mensagem do driver do banco pode citar o servidor e a conexão.
    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível conferir se a presença de um agente é a da TV ({ErrorType}).")]
    private partial void LogResolveFailed(string errorType);
}
