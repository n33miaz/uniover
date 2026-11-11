using System.Collections.Concurrent;
using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Contracts.Pairing;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.Outages;

/// <summary>O que a conciliação da presença descobriu: o próximo instante em que uma queda vai valer (nulo se nenhum) e o limite usado.</summary>
internal sealed record OutageCheck(DateTimeOffset? NextDue, TimeSpan Limit);

/// <summary>Uma mudança de presença que importa para as quedas: voltou (<c>Connected</c>) ou caiu, com o último sinal conhecido.</summary>
internal readonly record struct PresenceChange(string AgentId, bool Connected, DateTimeOffset? LastSignal);

/// <summary>
/// Ponte entre a presença em memória e o laço das quedas (<see cref="AgentOutageWorker"/>): quando um agente conecta ou cai, ou é
/// revogado, o laço é acordado e sabe qual agente e desde quando. Roda dentro da conexão do agente, sob o lock da presença,
/// então só enfileira e avisa; nunca lê o banco.
/// </summary>
internal sealed class AgentOutageWake : IAgentPresenceListener
{
    /// <summary>Teto da fila: as mudanças são raras; se o laço morreu, descarta as mais velhas e a conciliação de reserva cobre.</summary>
    private const int Capacity = 1024;

    private readonly ConcurrentQueue<PresenceChange> _changes = new();

    public WakeSignal Signal { get; } = new();

    public void OnPresenceChanged(AgentPresenceInfo info)
    {
        ArgumentNullException.ThrowIfNull(info);
        Enqueue(new PresenceChange(info.AgentId, info.Connected, info.DisconnectedAt ?? info.LastMessageAt));
    }

    /// <summary>A revogação fecha a queda aberta do agente (ele não "volta"): pede uma conciliação.</summary>
    public void OnRevoked(string agentId) => Enqueue(new PresenceChange(agentId, Connected: true, LastSignal: null));

    public bool TryDequeue(out PresenceChange change) => _changes.TryDequeue(out change);

    private void Enqueue(PresenceChange change)
    {
        while (_changes.Count >= Capacity)
        {
            _changes.TryDequeue(out _);
        }

        _changes.Enqueue(change);
        Signal.Notify();
    }
}

/// <summary>Avisa o laço das quedas que um agente foi revogado: a queda aberta dele só é encerrada na conciliação seguinte.</summary>
internal sealed class AgentOutageRevokedHandler(AgentOutageWake wake) : IIntegrationEventHandler<AgentRevoked>
{
    public Task HandleAsync(AgentRevoked integrationEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);
        wake.OnRevoked(integrationEvent.Slug);
        return Task.CompletedTask;
    }
}
