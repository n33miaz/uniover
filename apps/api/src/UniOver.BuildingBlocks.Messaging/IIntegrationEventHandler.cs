using UniOver.SharedKernel;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>
/// Assinante de um evento de integração. A entrega é "pelo menos uma vez": o assinante deve ser idempotente
/// (a base <see cref="IdempotentEventHandler{TContext, TEvent}"/> resolve isso com a tabela de inbox).
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Naming", "CA1711:Identifiers should not have incorrect suffix",
    Justification = "Nome pedido pela arquitetura: é um assinante de evento de integração, não um delegate de evento .NET.")]
public interface IIntegrationEventHandler<in TEvent>
    where TEvent : IIntegrationEvent
{
    Task HandleAsync(TEvent integrationEvent, CancellationToken cancellationToken);
}
