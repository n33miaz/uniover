using System.Text.Json;
using UniOver.BuildingBlocks.Persistence;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>Chave de um módulo (o prefixo do tipo do evento, que também é o nome do schema).</summary>
public readonly record struct ModuleKey(string Value)
{
    public override string ToString() => Value;
}

/// <summary>
/// Módulo que publica eventos: o contexto cuja outbox recebe o registro. O SQL de leitura da outbox é montado
/// aqui, uma única vez, porque o nome do schema não pode ser parâmetro SQL: ele passa pela validação restrita
/// antes de entrar no texto e todo o resto (data, tamanho do lote) vai como parâmetro.
/// </summary>
public sealed class OutboxModuleRegistration
{
    public OutboxModuleRegistration(string moduleKey, string schema, Type contextType)
    {
        ArgumentNullException.ThrowIfNull(contextType);
        SchemaName.EnsureValid(moduleKey, nameof(moduleKey));
        SchemaName.EnsureValid(schema, nameof(schema));

        ModuleKey = moduleKey;
        Schema = schema;
        ContextType = contextType;

        // Único SQL com identificador montado em texto desta peça: schema validado acima, tabela e colunas são
        // constantes. FOR UPDATE SKIP LOCKED não admite subconsulta nem composição, por isso é SQL cru.
        SelectPendingSql =
            "SELECT id, type, payload, occurred_at, created_at, attempts, next_attempt_at, processed_at, last_error "
            + $"FROM \"{schema}\".{MessagingModelBuilderExtensions.OutboxTable} "
            + "WHERE processed_at IS NULL AND next_attempt_at <= {0} "
            + "ORDER BY id LIMIT {1} FOR UPDATE SKIP LOCKED";
    }

    public string ModuleKey { get; }

    public string Schema { get; }

    public Type ContextType { get; }

    internal string SelectPendingSql { get; }
}

/// <summary>Módulos com outbox registrados (somente leitura depois da montagem do contêiner).</summary>
public sealed class OutboxModuleRegistry
{
    private readonly Dictionary<string, OutboxModuleRegistration> _byKey;

    public OutboxModuleRegistry(IEnumerable<OutboxModuleRegistration> registrations)
    {
        ArgumentNullException.ThrowIfNull(registrations);
        Registrations = registrations.ToList();

        var duplicated = Registrations.GroupBy(r => r.ModuleKey, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1);
        if (duplicated is not null)
        {
            throw new InvalidOperationException($"O módulo '{duplicated.Key}' registrou outbox mais de uma vez.");
        }

        _byKey = Registrations.ToDictionary(r => r.ModuleKey, StringComparer.Ordinal);
    }

    public IReadOnlyList<OutboxModuleRegistration> Registrations { get; }

    public bool TryGet(string moduleKey, out OutboxModuleRegistration registration) =>
        _byKey.TryGetValue(moduleKey, out registration!);

    public OutboxModuleRegistration? FindByContext(Type contextType) =>
        Registrations.FirstOrDefault(r => r.ContextType == contextType);
}

/// <summary>
/// Liga o tipo do evento (<c>tv.state-changed.v1</c>) ao tipo CLR do <c>*.Contracts</c> e sabe entregá-lo aos
/// assinantes. Preenchido por <c>AddIntegrationEvent</c> no módulo que assina.
/// </summary>
public sealed class IntegrationEventTypeRegistry
{
    private readonly Dictionary<string, IntegrationEventRegistration> _byType;

    public IntegrationEventTypeRegistry(IEnumerable<IntegrationEventRegistration> registrations)
    {
        ArgumentNullException.ThrowIfNull(registrations);
        _byType = [];
        foreach (var registration in registrations)
        {
            if (!_byType.TryAdd(registration.Type, registration))
            {
                throw new InvalidOperationException($"O tipo de evento '{registration.Type}' foi registrado duas vezes.");
            }
        }
    }

    public bool TryGet(string type, out IntegrationEventRegistration registration) =>
        _byType.TryGetValue(type, out registration!);
}

/// <summary>Um tipo de evento conhecido: o tipo CLR e a entrega (desserializa e chama todos os assinantes).</summary>
public sealed record IntegrationEventRegistration(
    string Type,
    Type ClrType,
    Func<IServiceProvider, string, CancellationToken, Task> DeliverAsync);

internal static class EventJson
{
    /// <summary>Opções compartilhadas e imutáveis depois do primeiro uso: publicar e entregar leem o mesmo formato.</summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}
