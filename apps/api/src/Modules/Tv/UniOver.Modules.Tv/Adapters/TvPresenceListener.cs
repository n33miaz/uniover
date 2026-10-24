using Microsoft.Extensions.Logging;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Assina a presença do Devices: quando o agente que controla a TV conecta ou cai, a tela é avisada na hora, sem
/// leitura nem comando e sem escrita no banco. Roda dentro da conexão do agente, então só atualiza memória e enfileira:
/// a tarefa abre um escopo curto, encontra a TV daquele agente e escolhe só o fluxo dela, sem segurar a conexão.
/// </summary>
internal sealed partial class TvPresenceListener(
    ITvAgentResolver agents,
    ITvStateStore state,
    ITvStreamPublisher stream,
    ILogger<TvPresenceListener> logger,
    IServiceScopeFactory? scopes = null)
    : IAgentPresenceListener
{
    public void OnPresenceChanged(AgentPresenceInfo info)
    {
        ArgumentNullException.ThrowIfNull(info);

        if (scopes is null && agents.TryGetLast(out var binding))
        {
            Apply(Guid.Empty, binding.AgentSlug!, info);
            return;
        }

        // A presença chega no escopo da conexão do agente, mas a tabela de TVs decide para qual fluxo SSE o aviso vai.
        // A leitura breve em um escopo próprio mantém o listener singleton sem capturar o DbContext da conexão.
        _ = ApplyAfterReadAsync(info);
    }

    private async Task ApplyAfterReadAsync(AgentPresenceInfo info)
    {
        try
        {
            if (scopes is not null)
            {
                await using var scope = scopes.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<TvDbContext>();
                var tv = await db.Tvs.AsNoTracking().SingleOrDefaultAsync(t => t.AgentSlug == info.AgentId);
                if (tv is not null)
                {
                    Apply(tv.Id, tv.AgentSlug, info);
                    return;
                }
            }

            var binding = await agents.ResolveAsync(CancellationToken.None);
            if (binding.IsConfigured)
            {
                Apply(Guid.Empty, binding.AgentSlug!, info);
            }
        }
#pragma warning disable CA1031 // Fora da conexão do agente ninguém trata o erro: um aviso perdido não pode derrubar o processo.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogResolveFailed(ex.GetType().Name);
        }
    }

    private void Apply(Guid tvId, string agentSlug, AgentPresenceInfo info)
    {
        if (!string.Equals(agentSlug, info.AgentId, StringComparison.Ordinal))
        {
            return;
        }

        if (state.NoteOnline(info.AgentId, info.Connected))
        {
            stream.PublishState(tvId, TvState.From(state.Last(info.AgentId), info.Connected));
        }
    }

    // Só o tipo do erro: a mensagem do driver do banco pode citar o servidor e a conexão.
    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível conferir se a presença de um agente é a da TV ({ErrorType}).")]
    private partial void LogResolveFailed(string errorType);
}
