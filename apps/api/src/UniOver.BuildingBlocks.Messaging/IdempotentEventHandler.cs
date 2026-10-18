using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.SharedKernel;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>
/// Assinante idempotente: entrega "pelo menos uma vez" vira efeito "uma vez". O registro do inbox e o efeito saem
/// no mesmo <c>SaveChanges</c>, então são atômicos no schema do assinante. O contexto precisa ter chamado
/// <c>AddInbox()</c> no modelo.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Naming", "CA1711:Identifiers should not have incorrect suffix",
    Justification = "Nome pedido pela arquitetura: é um assinante de evento de integração, não um delegate de evento .NET.")]
public abstract class IdempotentEventHandler<TContext, TEvent>(TContext context, TimeProvider time)
    : IIntegrationEventHandler<TEvent>
    where TContext : DbContext
    where TEvent : IIntegrationEvent
{
    private const string UniqueViolation = "23505";

    /// <summary>Nome estável do consumidor (parte da chave do inbox): trocar o nome reaplicaria os eventos.</summary>
    protected abstract string ConsumerName { get; }

    /// <summary>Aplica o efeito no contexto do assinante, sem chamar <c>SaveChanges</c>: quem salva é a base.</summary>
    protected abstract Task ApplyAsync(TEvent integrationEvent, TContext context, CancellationToken cancellationToken);

    public async Task HandleAsync(TEvent integrationEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);

        // Atalho para o caso comum de reentrega: nem chega a aplicar o efeito.
        var alreadyProcessed = await context.Set<InboxMessage>()
            .AnyAsync(m => m.EventId == integrationEvent.Id && m.Consumer == ConsumerName, cancellationToken);
        if (alreadyProcessed)
        {
            return;
        }

        context.Set<InboxMessage>().Add(new InboxMessage
        {
            EventId = integrationEvent.Id,
            Consumer = ConsumerName,
            ProcessedAt = time.GetUtcNow(),
        });

        try
        {
            await ApplyAsync(integrationEvent, context, cancellationToken);
            await context.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (IsInboxViolation(ex))
        {
            // Corrida entre duas entregas do mesmo evento: a outra venceu e o efeito dela já está gravado.
            // Descarta o que esta tentativa deixou no rastreamento e conta como sucesso.
            context.ChangeTracker.Clear();
        }
    }

    private static bool IsInboxViolation(DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: UniqueViolation } pg
        && pg.ConstraintName == MessagingModelBuilderExtensions.InboxKeyName;
}
