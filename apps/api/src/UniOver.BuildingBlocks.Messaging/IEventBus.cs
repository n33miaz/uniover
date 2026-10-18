using UniOver.SharedKernel;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>Porta de eventos: hoje em processo/outbox, amanhã um broker, sem mudar quem publica.</summary>
public interface IEventBus
{
    Task PublishAsync(IIntegrationEvent integrationEvent, CancellationToken cancellationToken = default);
}
