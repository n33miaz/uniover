using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.Modules.Devices.Features.Presence;

/// <summary>
/// Corpo dos eventos SSE de presença: <c>agent.presence.snapshot</c> traz todos os agentes vistos (ao abrir o
/// fluxo) e <c>agent.presence</c> traz o agente que mudou. A mesma forma nos dois deixa o PWA com um só leitor.
/// </summary>
internal sealed record PresenceUpdate(IReadOnlyList<AgentPresenceInfo> Agents)
{
    public const string SnapshotEvent = "agent.presence.snapshot";
    public const string ChangeEvent = "agent.presence";
}
