using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Tests.Support;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Tests.Commands;

public sealed class TvAuditQueueTests
{
    private static CommandAuditEntry Entry(string detail = "OK") =>
        CommandAuditEntry.Create(
            Guid.NewGuid(), "pc-casa", TvCommandNames.Key, detail, ok: true, errorCode: null, latencyMs: 5,
            new ClientInfo("198.51.100.9", "teste"), DateTimeOffset.UtcNow, Guid.NewGuid());

    private sealed class Recorder : ITvCommandAudit
    {
        private readonly List<CommandAuditEntry> _entries = [];

        public IReadOnlyList<CommandAuditEntry> Entries
        {
            get
            {
                lock (_entries)
                {
                    return [.. _entries];
                }
            }
        }

        public Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
        {
            lock (_entries)
            {
                _entries.Add(entry);
            }

            return Task.CompletedTask;
        }
    }

    private static (TvAuditWriter Writer, TvAuditQueue Queue, Recorder Recorder, CapturingLogger<TvAuditWriter> Log) Build()
    {
        var recorder = new Recorder();
        var services = new ServiceCollection();
        services.AddScoped<ITvCommandAudit>(_ => recorder);
        var queue = new TvAuditQueue(NullLogger<TvAuditQueue>.Instance);
        var log = new CapturingLogger<TvAuditWriter>();
        var writer = new TvAuditWriter(
            services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(), queue, log);
        return (writer, queue, recorder, log);
    }

    [Fact]
    public void AFullQueueDropsTheNewLines_AndCountsThem_InsteadOfGrowingWithoutLimit()
    {
        var queue = new TvAuditQueue(NullLogger<TvAuditQueue>.Instance);
        var log = new CapturingLogger<TvAuditWriter>();

        for (var i = 0; i < TvAuditQueue.Capacity + 25; i++)
        {
            queue.TryEnqueue(Entry());
        }

        queue.Pending.Should().Be(TvAuditQueue.Capacity);
        queue.Dropped.Should().Be(25);
    }

    [Fact]
    public async Task TheWriterRecordsWhatWasQueued_AndFinishesTheRestWhenTheHostStops()
    {
        var (writer, queue, recorder, log) = Build();
        await ((IHostedService)writer).StartAsync(CancellationToken.None);
        // O hospedeiro só cancela uma tarefa que já começou: espera o gravador estar de fato lendo a fila antes de parar.
        queue.TryEnqueue(Entry("primeira"));
        await queue.DrainAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        for (var i = 0; i < 30; i++)
        {
            queue.TryEnqueue(Entry($"k{i}"));
        }

        // Para sem esperar a fila esvaziar: o encerramento ainda grava o que já entrou.
        await ((IHostedService)writer).StopAsync(CancellationToken.None);

        recorder.Entries.Should().HaveCount(31, "pendentes {0}; log: {1}", queue.Pending, log.Everything);
        queue.Pending.Should().Be(0);
    }

    [Fact]
    public async Task DrainReturnsWhenEveryQueuedLineWasResolved()
    {
        var (writer, queue, recorder, _) = Build();
        await ((IHostedService)writer).StartAsync(CancellationToken.None);
        queue.TryEnqueue(Entry());
        queue.TryEnqueue(Entry());

        await queue.DrainAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        recorder.Entries.Should().HaveCount(2);
        await ((IHostedService)writer).StopAsync(CancellationToken.None);
    }
}
