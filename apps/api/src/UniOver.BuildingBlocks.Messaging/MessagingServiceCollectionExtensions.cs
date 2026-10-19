using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Persistence;
using UniOver.SharedKernel;

namespace UniOver.BuildingBlocks.Messaging;

public static class MessagingServiceCollectionExtensions
{
    /// <summary>Registra a porta de eventos, os registros, o sinal e o despachante. Uma vez, no Host.</summary>
    public static IServiceCollection AddUniOverMessaging(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.AddOptions<MessagingOptions>()
            .Bind(configuration.GetSection(MessagingOptions.SectionName))
            .ValidateOnStart();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IValidateOptions<MessagingOptions>, MessagingOptionsValidator>());

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<OutboxSignal>();
        services.TryAddSingleton<OutboxSignalInterceptor>();
        services.TryAddSingleton<OutboxModuleRegistry>();
        services.TryAddSingleton<IntegrationEventTypeRegistry>();
        services.TryAddScoped<IEventBus, OutboxEventBus>();

        // Instância única também acessível pelo tipo: o teste sobe dois despachantes sem montar um Host inteiro.
        services.TryAddSingleton<OutboxDispatcher>();
        services.AddHostedService(sp => sp.GetRequiredService<OutboxDispatcher>());
        return services;
    }

    /// <summary>
    /// Declara que o módulo publica eventos pela outbox do seu schema. <paramref name="moduleKey"/> é o prefixo do
    /// tipo do evento (<c>tv</c> em <c>tv.state-changed.v1</c>); o schema padrão é o próprio nome do módulo.
    /// </summary>
    public static IServiceCollection AddModuleOutbox<TContext>(
        this IServiceCollection services,
        string moduleKey,
        string? schema = null)
        where TContext : ModuleDbContext
    {
        ArgumentNullException.ThrowIfNull(services);

        // O construtor valida o identificador do schema (único ponto de SQL com texto montado).
        services.AddSingleton(new OutboxModuleRegistration(moduleKey, schema ?? moduleKey, typeof(TContext)));
        services.ConfigureDbContext<TContext>((sp, builder) =>
            builder.AddInterceptors(sp.GetRequiredService<OutboxSignalInterceptor>()));
        return services;
    }

    /// <summary>
    /// Declara que este módulo assina o evento <typeparamref name="TEvent"/> (tipo CLR do <c>*.Contracts</c>)
    /// com o nome versionado <paramref name="type"/>. Os assinantes são os <see cref="IIntegrationEventHandler{TEvent}"/>
    /// registrados na DI.
    /// </summary>
    public static IServiceCollection AddIntegrationEvent<TEvent>(this IServiceCollection services, string type)
        where TEvent : IIntegrationEvent
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrWhiteSpace(type);

        services.AddSingleton(new IntegrationEventRegistration(type, typeof(TEvent), async (sp, payload, ct) =>
        {
            var integrationEvent = JsonSerializer.Deserialize<TEvent>(payload, EventJson.Options)
                ?? throw new InvalidOperationException("Payload do evento vazio.");

            // Em sequência de propósito: se um assinante falha, o evento inteiro é reentregue (o inbox protege
            // os que já tinham aplicado).
            foreach (var handler in sp.GetServices<IIntegrationEventHandler<TEvent>>())
            {
                await handler.HandleAsync(integrationEvent, ct);
            }
        }));
        return services;
    }
}
