using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Tests.Support;

/// <summary>Presença que o teste controla: por padrão o agente está conectado (nada de falha rápida).</summary>
internal sealed class FakePresence(bool offlineBeyondGrace = false) : ITvAgentPresence
{
    public bool OfflineBeyondGrace { get; set; } = offlineBeyondGrace;

    public bool IsOnline(string agentId) => !OfflineBeyondGrace;

    public DateTimeOffset? OfflineSince(string agentId) => OfflineBeyondGrace ? OfflineAt : null;

    public DateTimeOffset? OfflineAt { get; set; }

    public bool IsOfflineBeyondReconnectGrace(string agentId) => OfflineBeyondGrace;
}
