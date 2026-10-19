using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Contracts.Pairing;

/// <summary>
/// Um agente foi revogado: o token dele deixa de valer. Imutável depois de publicado. Só ids, slug e instante.
/// </summary>
public sealed record AgentRevoked(Guid Id, DateTimeOffset OccurredAt, Guid AgentId, string Slug) : IIntegrationEvent
{
    public const string EventType = "devices.agent-revoked.v1";

    public string Type => EventType;
}
