using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Presence;
using UniOver.Modules.Devices.Ports;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>
/// As sessões vivas, uma por agente. Registrar a sessão, mexer na presença e avisar o SSE acontecem juntos sob o
/// mesmo lock: sem isso uma sessão antiga que termina logo depois de ser substituída marcaria o agente como
/// desconectado (e o SSE emitiria uma queda falsa) mesmo com a sessão nova de pé. O aviso ao SSE é só uma escrita
/// em fila (não bloqueia), então cabe dentro do lock e mantém a ordem dos eventos.
/// </summary>
internal sealed class AgentConnections(
    IPresenceStore presence,
    SseBroadcaster<PresenceUpdate> events,
    IEnumerable<IAgentPresenceListener>? listeners = null)
{
    private readonly IAgentPresenceListener[] _listeners = [.. listeners ?? []];

    private readonly object _gate = new();
    private readonly Dictionary<string, IAgentSession> _sessions = new(StringComparer.Ordinal);

    /// <summary>Torna <paramref name="session"/> a dona da conexão do agente e devolve a sessão que ela substituiu, se havia.</summary>
    public IAgentSession? Attach(IAgentSession session, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(session);
        lock (_gate)
        {
            _sessions.TryGetValue(session.AgentId, out var previous);
            _sessions[session.AgentId] = session;
            Announce(presence.MarkConnected(session.AgentId, now));
            return previous;
        }
    }

    /// <summary>
    /// Tira a sessão se ainda for a atual (comparar e remover, nunca remover pelo nome): sessão substituída não
    /// mexe na presença. Devolve se mudou o estado do agente.
    /// </summary>
    public bool Detach(IAgentSession session)
    {
        ArgumentNullException.ThrowIfNull(session);
        lock (_gate)
        {
            if (!_sessions.TryGetValue(session.AgentId, out var current) || !ReferenceEquals(current, session))
            {
                return false;
            }

            _sessions.Remove(session.AgentId);
            if (presence.MarkDisconnected(session.AgentId) is { } info)
            {
                Announce(info);
            }

            return true;
        }
    }

    public bool TryGet(string agentId, out IAgentSession session)
    {
        lock (_gate)
        {
            return _sessions.TryGetValue(agentId, out session!);
        }
    }

    public bool IsCurrent(IAgentSession session)
    {
        lock (_gate)
        {
            return _sessions.TryGetValue(session.AgentId, out var current) && ReferenceEquals(current, session);
        }
    }

    /// <summary>Registra versão e capacidades do <c>agent.hello.v1</c>; ignora sessão que já não é a atual.</summary>
    public void RecordHello(IAgentSession session, string agentVersion, IReadOnlyList<string> capabilities, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_sessions.TryGetValue(session.AgentId, out var current)
                && ReferenceEquals(current, session)
                && presence.RecordHello(session.AgentId, agentVersion, capabilities, now) is { } info)
            {
                Announce(info);
            }
        }
    }

    public void Touch(IAgentSession session, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_sessions.TryGetValue(session.AgentId, out var current) && ReferenceEquals(current, session))
            {
                presence.Touch(session.AgentId, now);
            }
        }
    }

    private void Announce(AgentPresenceInfo info)
    {
        events.Publish(new SseMessage<PresenceUpdate>(PresenceUpdate.ChangeEvent, new PresenceUpdate([info])));

        // Em processo e sob o lock (mantém a ordem): quem escuta só pode enfileirar, nunca esperar. Falha de um
        // ouvinte não pode atrapalhar a conexão do agente nem os outros ouvintes.
        foreach (var listener in _listeners)
        {
            try
            {
                listener.OnPresenceChanged(info);
            }
#pragma warning disable CA1031 // Um ouvinte com defeito não derruba a presença.
            catch (Exception)
#pragma warning restore CA1031
            {
            }
        }
    }
}
