using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Devices.Contracts.Pairing;

namespace UniOver.Modules.Devices.Features.Tokens;

/// <summary>
/// Trata o evento de revogação tirando o agente do cache de tokens. A entrega é "pelo menos uma vez" e invalidar
/// duas vezes não muda nada, então não precisa de inbox.
/// </summary>
internal sealed class AgentRevokedCacheInvalidator(IDeviceTokenCache cache) : IIntegrationEventHandler<AgentRevoked>
{
    public Task HandleAsync(AgentRevoked integrationEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);
        cache.Invalidate(integrationEvent.AgentId);
        return Task.CompletedTask;
    }
}
