using System.Collections.Frozen;
using UniOver.BuildingBlocks.AgentProtocol.Generated;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>
/// Quem manda cada tipo de mensagem, como o <c>asyncapi.yaml</c> declara (canal de comandos: API para agente;
/// canal de eventos: agente para API). O agente que manda um tipo que só a API manda (por exemplo uma tecla de
/// TV) está fora do contrato, mesmo com o formato certo. Tipo novo no contrato precisa entrar numa das duas
/// listas: um teste falha enquanto houver tipo sem direção.
/// </summary>
internal static class AgentMessageDirections
{
    /// <summary>Tipos que o agente envia à API.</summary>
    public static FrozenSet<string> FromAgent { get; } = new[]
    {
        AgentMessageTypes.AgentHelloV1,
        AgentMessageTypes.CommandResultV1,
        AgentMessageTypes.TvAppsV1,
        AgentMessageTypes.TvStateV1,
        AgentMessageTypes.TvWatchdogV1,
    }.ToFrozenSet(StringComparer.Ordinal);

    /// <summary>Tipos que a API envia ao agente.</summary>
    public static FrozenSet<string> ToAgent { get; } = new[]
    {
        AgentMessageTypes.TvAppLaunchV1,
        AgentMessageTypes.TvAppsRefreshV1,
        AgentMessageTypes.TvKeyV1,
        AgentMessageTypes.TvKeyV2,
        AgentMessageTypes.TvTextV1,
        AgentMessageTypes.TvWakeV1,
    }.ToFrozenSet(StringComparer.Ordinal);
}
