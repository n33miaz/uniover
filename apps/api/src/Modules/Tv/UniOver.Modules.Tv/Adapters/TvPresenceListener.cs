using Microsoft.Extensions.Logging;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Features.Cleanup;

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
    private readonly object _gate = new();
    private readonly Dictionary<string, Task> _pending = new(StringComparer.Ordinal);

    public void OnPresenceChanged(AgentPresenceInfo info)
    {
        ArgumentNullException.ThrowIfNull(info);

        if (info.Connected && scopes is not null
            && info.Capabilities.Contains(CleanupSettingsPublisher.Capability, StringComparer.Ordinal))
        {
            _ = PublishCleanupSettingsAsync(info.AgentId);
        }

        if (scopes is null && agents.TryGetLast(out var binding))
        {
            Apply(Guid.Empty, binding.AgentSlug!, info);
            return;
        }

        // A presença chega no escopo da conexão do agente, mas a tabela de TVs decide para qual fluxo SSE o aviso vai.
        // A leitura breve em um escopo próprio mantém o listener singleton sem capturar o DbContext da conexão.
        lock (_gate)
        {
            _pending.TryGetValue(info.AgentId, out var previous);
            // A consulta à TV é assíncrona: uma queda não pode terminar depois da reconexão e sobrescrever o estado novo.
            _pending[info.AgentId] = ApplyInOrderAsync(previous ?? Task.CompletedTask, info);
        }
    }

    private async Task ApplyInOrderAsync(Task previous, AgentPresenceInfo info)
    {
        await previous;
        await ApplyAfterReadAsync(info);
    }

    private async Task PublishCleanupSettingsAsync(string agentSlug)
    {
        try
        {
            // Resolvido na hora, e não no construtor: o publicador chega ao transporte do Devices, que por sua vez
            // recebe este ouvinte, e um construtor assim fecharia um ciclo de dependências.
            await using var scope = scopes!.CreateAsyncScope();
            if (scope.ServiceProvider.GetService<ITvCleanupSettingsPublisher>() is { } publisher)
                await publisher.PublishAsync(agentSlug);
        }
        catch (Exception)
        {
            // A próxima repetição do hello tenta de novo; presença não pode cair por configuração.
        }
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

        // Uma conexão recém-aberta (o hello ainda não chegou) avisa a tela mesmo sem mudança: durante a graça de presença a
        // tela nunca viu a queda, mas um comando que falhou na janela pode tê-la marcado fora do ar por conta própria, e é
        // este aviso que a corrige.
        var justConnected = info.Connected && info.AgentVersion is null;
        if (state.NoteOnline(info.AgentId, info.Connected) || justConnected)
        {
            stream.PublishState(tvId, TvState.From(state.Last(info.AgentId), info.Connected, offlineSince: info.DisconnectedAt ?? info.LastMessageAt));
        }
    }

    // Só o tipo do erro: a mensagem do driver do banco pode citar o servidor e a conexão.
    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível conferir se a presença de um agente é a da TV ({ErrorType}).")]
    private partial void LogResolveFailed(string errorType);
}
