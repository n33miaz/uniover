using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Estado da TV em memória. É da instância (singleton do módulo), não estático, e some quando a API reinicia: o
/// agente manda o estado de novo ao reconectar. O volume mora só aqui.
/// </summary>
internal sealed class InMemoryTvStateStore : ITvStateStore
{
    private readonly object _gate = new();
    private readonly Dictionary<string, TvStateSnapshot> _states = new(StringComparer.Ordinal);
    private readonly Dictionary<string, bool> _online = new(StringComparer.Ordinal);

    public TvStateSnapshot? Last(string agentId)
    {
        lock (_gate)
        {
            return _states.GetValueOrDefault(agentId);
        }
    }

    public void Apply(string agentId, TvStateSnapshot snapshot)
    {
        lock (_gate)
        {
            _states[agentId] = snapshot;
        }
    }

    public bool NoteOnline(string agentId, bool online)
    {
        lock (_gate)
        {
            var changed = !_online.TryGetValue(agentId, out var previous) || previous != online;
            _online[agentId] = online;
            return changed;
        }
    }
}
