using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Persistence;
using UniOver.SharedKernel;

namespace UniOver.IntegrationTests.Messaging;

/// <summary>Módulo de teste que publica: schema próprio, com outbox, dead letters e inbox.</summary>
public sealed class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "msg_orders";

    protected override string Schema => SchemaName;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.Entity<OrderRow>(e =>
        {
            e.ToTable("orders");
            e.HasKey(x => x.Id);
            e.Property(x => x.Number).HasMaxLength(50).IsRequired();
        });
        modelBuilder.AddOutbox().AddDeadLetters().AddInbox();
    }
}

/// <summary>Segundo módulo de teste: também publica e é o assinante (efeito gravado no schema dele).</summary>
public sealed class BillingDbContext(DbContextOptions<BillingDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "msg_billing";

    protected override string Schema => SchemaName;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.Entity<EffectRow>(e =>
        {
            e.ToTable("effects");
            e.HasKey(x => x.Id);
            e.Property(x => x.Number).HasMaxLength(50).IsRequired();
        });
        modelBuilder.AddOutbox().AddDeadLetters().AddInbox();
    }
}

public sealed class OrderRow
{
    public Guid Id { get; set; }

    public string Number { get; set; } = string.Empty;
}

public sealed class EffectRow
{
    public Guid Id { get; set; }

    public string Number { get; set; } = string.Empty;
}

public sealed record OrderCreated(Guid Id, DateTimeOffset OccurredAt, string Number) : IIntegrationEvent
{
    public const string TypeName = "orders.created.v1";

    public string Type => TypeName;

    public static OrderCreated New(string number = "N-1") => new(IdGenerator.NewId(), DateTimeOffset.UtcNow, number);
}

/// <summary>Evento de um módulo sem outbox registrada: publicar deve falhar com erro de composição.</summary>
public sealed record UnroutedEvent(Guid Id, DateTimeOffset OccurredAt) : IIntegrationEvent
{
    public string Type => "ghost.happened.v1";
}

/// <summary>Observa as entregas: conta por id, falha sob comando e pode demorar um pouco para forçar sobreposição.</summary>
public sealed class DeliveryProbe
{
    public ConcurrentDictionary<Guid, int> Delivered { get; } = new();

    public ConcurrentDictionary<Guid, int> Attempts { get; } = new();

    /// <summary>Quantas primeiras tentativas de cada evento falham antes de passar.</summary>
    public int FailuresBeforeSuccess { get; set; }

    public bool AlwaysFail { get; set; }

    public TimeSpan Delay { get; set; }

    public int TotalDelivered => Delivered.Values.Sum();
}

public sealed class ProbeHandler(DeliveryProbe probe) : IIntegrationEventHandler<OrderCreated>
{
    public async Task HandleAsync(OrderCreated integrationEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);
        var attempt = probe.Attempts.AddOrUpdate(integrationEvent.Id, 1, (_, n) => n + 1);

        if (probe.Delay > TimeSpan.Zero)
        {
            await Task.Delay(probe.Delay, cancellationToken);
        }

        if (probe.AlwaysFail || attempt <= probe.FailuresBeforeSuccess)
        {
            throw new InvalidOperationException("falha de teste");
        }

        probe.Delivered.AddOrUpdate(integrationEvent.Id, 1, (_, n) => n + 1);
    }
}

/// <summary>Liga uma falha depois do efeito, para provar que efeito e inbox são atômicos.</summary>
public sealed class ProjectionSwitch
{
    public bool FailAfterEffect { get; set; }
}

public sealed class OrderProjection(BillingDbContext context, TimeProvider time, ProjectionSwitch toggle)
    : IdempotentEventHandler<BillingDbContext, OrderCreated>(context, time)
{
    protected override string ConsumerName => "billing.order-projection";

    protected override Task ApplyAsync(OrderCreated integrationEvent, BillingDbContext db, CancellationToken cancellationToken)
    {
        db.Set<EffectRow>().Add(new EffectRow { Id = IdGenerator.NewId(), Number = integrationEvent.Number });
        return toggle.FailAfterEffect ? throw new InvalidOperationException("falha depois do efeito") : Task.CompletedTask;
    }
}

/// <summary>Conta os comandos enviados ao banco por tipo de contexto (prova de que a fila vazia fica em silêncio).</summary>
public sealed class CommandCounter : DbCommandInterceptor
{
    private readonly ConcurrentDictionary<Type, int> _counts = new();

    public int For<TContext>() => _counts.GetValueOrDefault(typeof(TContext));

    public int Total => _counts.Values.Sum();

    public override InterceptionResult<System.Data.Common.DbDataReader> ReaderExecuting(
        System.Data.Common.DbCommand command, CommandEventData eventData, InterceptionResult<System.Data.Common.DbDataReader> result)
    {
        Count(eventData);
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<System.Data.Common.DbDataReader>> ReaderExecutingAsync(
        System.Data.Common.DbCommand command, CommandEventData eventData, InterceptionResult<System.Data.Common.DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        Count(eventData);
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }

    public override InterceptionResult<int> NonQueryExecuting(
        System.Data.Common.DbCommand command, CommandEventData eventData, InterceptionResult<int> result)
    {
        Count(eventData);
        return base.NonQueryExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        System.Data.Common.DbCommand command, CommandEventData eventData, InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Count(eventData);
        return base.NonQueryExecutingAsync(command, eventData, result, cancellationToken);
    }

    private void Count(CommandEventData eventData)
    {
        if (eventData.Context is { } context)
        {
            _counts.AddOrUpdate(context.GetType(), 1, (_, n) => n + 1);
        }
    }
}
