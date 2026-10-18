using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.SharedKernel;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>
/// Publica gravando na outbox do módulo dono, no contexto do próprio caso de uso. Não chama <c>SaveChanges</c>:
/// o commit é o do caso de uso, então dado e evento saem na mesma transação (ou nenhum dos dois sai).
/// </summary>
internal sealed class OutboxEventBus(IServiceProvider services, OutboxModuleRegistry modules, TimeProvider time) : IEventBus
{
    public Task PublishAsync(IIntegrationEvent integrationEvent, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);

        var type = integrationEvent.Type;
        var dot = type?.IndexOf('.', StringComparison.Ordinal) ?? -1;
        if (string.IsNullOrWhiteSpace(type) || dot <= 0)
        {
            // Erro de composição do publicador, não do usuário: o tipo precisa ser "<modulo>.<nome>.v<n>".
            throw new InvalidOperationException(
                $"Tipo de evento inválido '{type}': esperado '<modulo>.<nome>.v<versao>' (ex.: tv.state-changed.v1).");
        }

        var moduleKey = type[..dot];
        if (!modules.TryGet(moduleKey, out var registration))
        {
            throw new InvalidOperationException(
                $"O módulo '{moduleKey}' do evento '{type}' não tem outbox registrada (falta AddModuleOutbox).");
        }

        var context = (DbContext)services.GetRequiredService(registration.ContextType);
        context.Set<OutboxMessage>().Add(new OutboxMessage
        {
            Id = integrationEvent.Id,
            Type = type,
            Payload = JsonSerializer.Serialize(integrationEvent, integrationEvent.GetType(), EventJson.Options),
            OccurredAt = integrationEvent.OccurredAt.ToUniversalTime(),
            CreatedAt = time.GetUtcNow(),
            Attempts = 0,
            NextAttemptAt = time.GetUtcNow(),
        });

        return Task.CompletedTask;
    }
}
