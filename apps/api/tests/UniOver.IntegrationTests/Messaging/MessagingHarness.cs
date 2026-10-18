using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Npgsql;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Messaging;

public sealed record HarnessSettings
{
    public TimeProvider? Time { get; init; }

    public int IdlePollSeconds { get; init; } = 21600;

    public int MaxAttempts { get; init; } = 8;

    public int BatchSize { get; init; } = 20;

    public bool WithProbe { get; init; } = true;

    public bool WithProjection { get; init; }
}

/// <summary>
/// Monta uma "instância da API" mínima (contêiner de DI com mensageria e os dois contextos de teste) contra o
/// banco do teste. Duas instâncias contra o mesmo banco representam dois despachantes concorrentes.
/// </summary>
public sealed class MessagingHarness : IAsyncDisposable
{
    private readonly ServiceProvider _services;
    private bool _started;

    private MessagingHarness(ServiceProvider services, DeliveryProbe probe, CommandCounter commands, ProjectionSwitch projection)
    {
        _services = services;
        Probe = probe;
        Commands = commands;
        Projection = projection;
    }

    public DeliveryProbe Probe { get; }

    public CommandCounter Commands { get; }

    public ProjectionSwitch Projection { get; }

    public IServiceProvider Services => _services;

    public OutboxDispatcher Dispatcher => _services.GetRequiredService<OutboxDispatcher>();

    public static MessagingHarness Create(TestDatabase database, HarnessSettings? settings = null)
    {
        ArgumentNullException.ThrowIfNull(database);
        settings ??= new HarnessSettings();

        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = database.OwnerConnection,
            ["Messaging:IdlePollSeconds"] = settings.IdlePollSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Messaging:MaxAttempts"] = settings.MaxAttempts.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Messaging:BatchSize"] = settings.BatchSize.ToString(System.Globalization.CultureInfo.InvariantCulture),
        }).Build();

        var probe = new DeliveryProbe();
        var commands = new CommandCounter();
        var projection = new ProjectionSwitch();
        var assembly = typeof(OrdersDbContext).Assembly;

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IHostEnvironment>(new TestEnvironment());
        if (settings.Time is not null)
        {
            services.AddSingleton(settings.Time);
        }

        services.AddModuleDbContext<OrdersDbContext>(configuration, OrdersDbContext.SchemaName, assembly);
        services.AddModuleDbContext<BillingDbContext>(configuration, BillingDbContext.SchemaName, assembly);
        services.AddModuleOutbox<OrdersDbContext>("orders", OrdersDbContext.SchemaName);
        services.AddModuleOutbox<BillingDbContext>("billing", BillingDbContext.SchemaName);
        services.AddUniOverMessaging(configuration);

        services.ConfigureDbContext<OrdersDbContext>(b => b.AddInterceptors(commands));
        services.ConfigureDbContext<BillingDbContext>(b => b.AddInterceptors(commands));
        services.AddSingleton(projection);

        if (settings.WithProbe || settings.WithProjection)
        {
            services.AddIntegrationEvent<OrderCreated>(OrderCreated.TypeName);
        }

        if (settings.WithProbe)
        {
            services.AddSingleton(probe);
            services.AddScoped<IIntegrationEventHandler<OrderCreated>, ProbeHandler>();
        }

        if (settings.WithProjection)
        {
            services.AddScoped<OrderProjection>();
            services.AddScoped<IIntegrationEventHandler<OrderCreated>>(sp => sp.GetRequiredService<OrderProjection>());
        }

        return new MessagingHarness(services.BuildServiceProvider(validateScopes: true), probe, commands, projection);
    }

    /// <summary>Cria os schemas e tabelas dos dois contextos (o banco de teste é novo a cada teste).</summary>
    public async Task CreateSchemasAsync(TestDatabase database)
    {
        ArgumentNullException.ThrowIfNull(database);
        await using var scope = _services.CreateAsyncScope();
        foreach (var context in new DbContext[]
        {
            scope.ServiceProvider.GetRequiredService<OrdersDbContext>(),
            scope.ServiceProvider.GetRequiredService<BillingDbContext>(),
        })
        {
            var script = context.Database.GenerateCreateScript();
            await using var connection = new NpgsqlConnection(database.OwnerConnection);
            await connection.OpenAsync(TestContext.Current.CancellationToken);
            await using var command = new NpgsqlCommand(script, connection);
            await command.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
        }
    }

    public async Task StartAsync()
    {
        _started = true;
        await Dispatcher.StartAsync(TestContext.Current.CancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        if (_started)
        {
            await Dispatcher.StopAsync(CancellationToken.None);
        }

        await _services.DisposeAsync();
    }

    /// <summary>Publica N eventos no módulo de pedidos, um <c>SaveChanges</c> por lote.</summary>
    public async Task<List<OrderCreated>> PublishAsync(int count, int perSave = 20)
    {
        var published = new List<OrderCreated>();
        while (published.Count < count)
        {
            await using var scope = _services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
            var bus = scope.ServiceProvider.GetRequiredService<IEventBus>();
            for (var i = 0; i < perSave && published.Count < count; i++)
            {
                var evt = OrderCreated.New($"N-{published.Count}");
                db.Set<OrderRow>().Add(new OrderRow { Id = evt.Id, Number = evt.Number });
                await bus.PublishAsync(evt, TestContext.Current.CancellationToken);
                published.Add(evt);
            }

            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }

        return published;
    }

    public async Task<List<OutboxMessage>> OutboxAsync()
    {
        await using var scope = _services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        return await db.Set<OutboxMessage>().AsNoTracking().OrderBy(m => m.Id).ToListAsync(TestContext.Current.CancellationToken);
    }

    public async Task<List<DeadLetter>> DeadLettersAsync()
    {
        await using var scope = _services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        return await db.Set<DeadLetter>().AsNoTracking().ToListAsync(TestContext.Current.CancellationToken);
    }

    /// <summary>Espera real curta e limitada (poll de 20 ms) por uma condição; falha com a descrição se estourar.</summary>
    public static async Task EventuallyAsync(Func<Task<bool>> condition, string what, int timeoutSeconds = 15)
    {
        ArgumentNullException.ThrowIfNull(condition);
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        while (!await condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException($"Condição não atendida a tempo: {what}.");
            }

            await Task.Delay(20, TestContext.Current.CancellationToken);
        }
    }

    private sealed class TestEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";

        public string ApplicationName { get; set; } = "UniOver.IntegrationTests";

        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;

        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
