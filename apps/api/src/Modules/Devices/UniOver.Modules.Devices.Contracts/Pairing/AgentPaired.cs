using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Contracts.Pairing;

/// <summary>
/// Um agente foi pareado e passa a poder receber token. Imutável depois de publicado: mudança incompatível vira
/// <c>devices.agent-paired.v2</c>. Só ids, slug e instante; nada de segredo.
/// </summary>
public sealed record AgentPaired(Guid Id, DateTimeOffset OccurredAt, Guid AgentId, string Slug) : IIntegrationEvent
{
    public const string EventType = "devices.agent-paired.v1";

    public string Type => EventType;
}
