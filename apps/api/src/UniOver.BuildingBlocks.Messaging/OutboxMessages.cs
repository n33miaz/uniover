using System.Text.Json;
using UniOver.SharedKernel;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>
/// Monta a linha da outbox de um evento, com o mesmo formato que <see cref="IEventBus"/> grava. Existe para quem escreve na
/// transação de outro contexto (o pareamento, que entra na conexão do Devices) e não pode usar o contexto do escopo.
/// </summary>
public static class OutboxMessages
{
    public static OutboxMessage Create(IIntegrationEvent integrationEvent, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);

        return new OutboxMessage
        {
            Id = integrationEvent.Id,
            Type = integrationEvent.Type,
            Payload = JsonSerializer.Serialize(integrationEvent, integrationEvent.GetType(), EventJson.Options),
            OccurredAt = integrationEvent.OccurredAt.ToUniversalTime(),
            CreatedAt = now,
            Attempts = 0,
            NextAttemptAt = now,
        };
    }
}
