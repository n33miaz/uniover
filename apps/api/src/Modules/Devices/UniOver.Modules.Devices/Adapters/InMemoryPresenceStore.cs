using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Ports;

namespace UniOver.Modules.Devices.Adapters;

/// <summary>
/// Presença em memória. O estado é da instância (singleton do módulo), não estático, e some quando a API reinicia:
/// os agentes reconectam e a presença se refaz sozinha. Um lock simples basta: são poucos agentes e operações curtas.
/// </summary>
internal sealed class InMemoryPresenceStore(TimeProvider time, IOptions<DevicesTransportOptions> options)
    : IPresenceStore, IAgentPresenceReader
{
    private readonly DateTimeOffset _startedAt = time.GetUtcNow();
    private readonly object _gate = new();
    private readonly Dictionary<string, AgentPresenceInfo> _agents = new(StringComparer.Ordinal);

    public AgentPresenceInfo MarkConnected(string agentId, DateTimeOffset now)
    {
        var info = new AgentPresenceInfo(agentId, true, now, null, [], null);
        lock (_gate)
        {
            _agents[agentId] = info;
        }

        return info;
    }

    public TimeSpan ReconnectGrace => options.Value.ReconnectGrace;

    public DateTimeOffset? OfflineSince(string agentId)
    {
        lock (_gate)
        {
            if (!_agents.TryGetValue(agentId, out var current))
            {
                return _startedAt;
            }

            return current.Connected ? null : current.DisconnectedAt ?? _startedAt;
        }
    }

    public AgentPresenceInfo? MarkDisconnected(string agentId, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (!_agents.TryGetValue(agentId, out var current))
            {
                return null;
            }

            var info = current with { Connected = false, DisconnectedAt = now };
            _agents[agentId] = info;
            return info;
        }
    }

    public AgentPresenceInfo? RecordHello(string agentId, string agentVersion, IReadOnlyList<string> capabilities, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (!_agents.TryGetValue(agentId, out var current) || !current.Connected)
            {
                return null;
            }

            var info = current with { AgentVersion = agentVersion, Capabilities = [.. capabilities], LastMessageAt = now };
            _agents[agentId] = info;
            return info;
        }
    }

    public void Touch(string agentId, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_agents.TryGetValue(agentId, out var current) && current.Connected)
            {
                _agents[agentId] = current with { LastMessageAt = now };
            }
        }
    }

    public AgentPresenceInfo? Get(string agentId)
    {
        lock (_gate)
        {
            return _agents.GetValueOrDefault(agentId);
        }
    }

    public IReadOnlyList<AgentPresenceInfo> All()
    {
        lock (_gate)
        {
            return [.. _agents.Values.OrderBy(a => a.AgentId, StringComparer.Ordinal)];
        }
    }
}
