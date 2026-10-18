using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>
/// Entrega os eventos da outbox aos assinantes, um laço por módulo.
/// <para>
/// Sem polling curto, de propósito: o Neon gratuito suspende o compute após 5 min parado e o plano tem 100
/// CU-horas por mês; uma consulta a cada poucos segundos manteria o banco sempre acordado e estouraria o limite.
/// Por isso cada laço só acorda por (1) sinal em processo depois de um commit com outbox, (2) o próximo retry
/// agendado, ou (3) o tique de reserva, que é UM relógio compartilhado por todos os módulos (todos varrem no
/// mesmo instante e dividem um só despertar do banco). Na partida cada módulo faz uma varredura, para recuperar
/// o que ficou pendente antes de um reinício.
/// </para>
/// <para>
/// A entrega e o <c>processed_at</c> acontecem na MESMA transação que segura as linhas do
/// <c>FOR UPDATE SKIP LOCKED</c>: se a transação fosse confirmada antes da entrega, dois despachantes poderiam
/// entregar o mesmo evento depois de uma falha.
/// </para>
/// </summary>
public sealed partial class OutboxDispatcher(
    IServiceScopeFactory scopeFactory,
    OutboxModuleRegistry modules,
    IntegrationEventTypeRegistry eventTypes,
    OutboxSignal signal,
    IOptions<MessagingOptions> options,
    TimeProvider time,
    ILogger<OutboxDispatcher> logger) : BackgroundService
{
    /// <summary>Folga mínima entre varreduras do mesmo módulo, para nunca virar laço apertado se o banco está contendido.</summary>
    private static readonly TimeSpan MinimumWait = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Primeira espera depois de uma varredura que falhou (ex.: banco fora do ar ou ainda sem as tabelas). Dobra a
    /// cada falha seguida até o intervalo de reserva: repetir a cada 30 s para sempre manteria o Neon acordado.
    /// </summary>
    private static readonly TimeSpan FailureWait = TimeSpan.FromSeconds(30);

    private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(15);

    private readonly MessagingOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (modules.Registrations.Count == 0)
        {
            return;
        }

        var wakes = modules.Registrations.ToDictionary(
            r => r.ModuleKey,
            _ => Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
            {
                FullMode = BoundedChannelFullMode.DropWrite,
                SingleReader = true,
            }),
            StringComparer.Ordinal);

        // O relógio de reserva: um só para todos os módulos.
        var interval = TimeSpan.FromSeconds(_options.IdlePollSeconds);
        using var reserve = time.CreateTimer(
            _ =>
            {
                foreach (var wake in wakes.Values)
                {
                    wake.Writer.TryWrite(true);
                }
            },
            null,
            interval,
            interval);

        var tasks = modules.Registrations
            .Select(r => RunModuleAsync(r, wakes[r.ModuleKey], stoppingToken))
            .Append(PumpSignalsAsync(wakes, stoppingToken))
            .ToList();

        await Task.WhenAll(tasks);
    }

    private async Task PumpSignalsAsync(Dictionary<string, Channel<bool>> wakes, CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var module in signal.Reader.ReadAllAsync(cancellationToken))
            {
                if (wakes.TryGetValue(module.Value, out var wake))
                {
                    wake.Writer.TryWrite(true);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Parada normal do serviço.
        }
    }

    private async Task RunModuleAsync(OutboxModuleRegistration module, Channel<bool> wake, CancellationToken cancellationToken)
    {
        var consecutiveFailures = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            DateTimeOffset? nextRetry;
            try
            {
                nextRetry = await SweepAsync(module, cancellationToken);
                consecutiveFailures = 0;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // Nenhuma exceção pode derrubar o laço do módulo: registra e tenta de novo depois.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                LogSweepFailed(ex, module.ModuleKey);
                consecutiveFailures++;
                nextRetry = time.GetUtcNow() + FailureBackoffFor(consecutiveFailures, TimeSpan.FromSeconds(_options.IdlePollSeconds));
            }

            try
            {
                await WaitAsync(wake, nextRetry, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    /// <summary>Espera o sinal, o retry agendado ou o tique de reserva, o que vier primeiro.</summary>
    private async Task WaitAsync(Channel<bool> wake, DateTimeOffset? nextRetry, CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        Task retryTask;
        if (nextRetry is null)
        {
            retryTask = Task.Delay(Timeout.InfiniteTimeSpan, linked.Token);
        }
        else
        {
            var delay = nextRetry.Value - time.GetUtcNow();
            retryTask = Task.Delay(delay < MinimumWait ? MinimumWait : delay, time, linked.Token);
        }

        // WaitToRead não consome o item: uma leitura pendente descartada engoliria o próximo sinal.
        var signalTask = wake.Reader.WaitToReadAsync(linked.Token).AsTask();

        await Task.WhenAny(signalTask, retryTask);
        await linked.CancelAsync();

        await IgnoreCancellationAsync(signalTask);
        await IgnoreCancellationAsync(retryTask);
        cancellationToken.ThrowIfCancellationRequested();

        // Vários sinais juntos viram uma única varredura.
        while (wake.Reader.TryRead(out _))
        {
        }
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
            // Esperado: a outra tarefa de espera venceu e esta foi cancelada.
        }
    }

    /// <summary>Esvazia o que está devido e devolve o próximo <c>next_attempt_at</c> pendente, se houver.</summary>
    private async Task<DateTimeOffset?> SweepAsync(OutboxModuleRegistration module, CancellationToken cancellationToken)
    {
        int processed;
        do
        {
            processed = await ProcessBatchAsync(module, cancellationToken);
        }
        while (processed >= _options.BatchSize);

        // Ainda na varredura (não é consulta periódica): descobre o retry mais próximo, inclusive de outra instância.
        using var scope = scopeFactory.CreateScope();
        var context = ResolveContext(scope, module);
        return await context.Set<OutboxMessage>()
            .Where(m => m.ProcessedAt == null)
            .MinAsync(m => (DateTimeOffset?)m.NextAttemptAt, cancellationToken);
    }

    private async Task<int> ProcessBatchAsync(OutboxModuleRegistration module, CancellationToken cancellationToken)
    {
        using var scope = scopeFactory.CreateScope();
        var context = ResolveContext(scope, module);

        await using var transaction = await context.Database.BeginTransactionAsync(cancellationToken);

        // SQL cru parametrizado: o schema foi validado no registro; data e tamanho do lote são parâmetros.
        var messages = await context.Set<OutboxMessage>()
            .FromSqlRaw(module.SelectPendingSql, time.GetUtcNow(), _options.BatchSize)
            .ToListAsync(cancellationToken);

        foreach (var message in messages)
        {
            await DeliverAsync(context, message, cancellationToken);
        }

        await context.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return messages.Count;
    }

    private async Task DeliverAsync(DbContext context, OutboxMessage message, CancellationToken cancellationToken)
    {
        try
        {
            if (!eventTypes.TryGet(message.Type, out var registration))
            {
                throw new UnknownEventTypeException();
            }

            // Escopo novo por entrega: o assinante tem o seu próprio contexto, em outra transação.
            using var handlerScope = scopeFactory.CreateScope();
            await registration.DeliverAsync(handlerScope.ServiceProvider, message.Payload, cancellationToken);

            message.ProcessedAt = time.GetUtcNow();
            message.LastError = null;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
#pragma warning disable CA1031 // Falha de assinante vira retry/dead letter; nunca derruba o laço.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            var now = time.GetUtcNow();
            message.Attempts++;

            // Só o nome do tipo da exceção: a mensagem poderia carregar dado do payload ou segredo.
            message.LastError = ex.GetType().Name;
            LogDeliveryFailed(message.Id, message.Type, message.Attempts, message.LastError);

            if (message.Attempts >= _options.MaxAttempts)
            {
                context.Set<DeadLetter>().Add(new DeadLetter
                {
                    Id = message.Id,
                    Type = message.Type,
                    Payload = message.Payload,
                    OccurredAt = message.OccurredAt,
                    FailedAt = now,
                    Attempts = message.Attempts,
                    LastError = message.LastError,
                });
                message.ProcessedAt = now;
            }
            else
            {
                message.NextAttemptAt = now + BackoffFor(message.Attempts);
            }
        }
    }

    /// <summary>min(5 s × 2^(tentativas−1), 15 min) mais até 20% de jitter, para os retries não marcharem juntos.</summary>
    internal static TimeSpan BackoffFor(int attempts)
    {
        var seconds = Math.Min(5d * Math.Pow(2, attempts - 1), MaxBackoff.TotalSeconds);
        var jitter = 1 + (Random.Shared.NextDouble() * 0.2);
        return TimeSpan.FromSeconds(seconds * jitter);
    }

    /// <summary>30 s, 60 s, 120 s... até o intervalo de reserva.</summary>
    internal static TimeSpan FailureBackoffFor(int consecutiveFailures, TimeSpan ceiling)
    {
        var seconds = FailureWait.TotalSeconds * Math.Pow(2, Math.Min(consecutiveFailures - 1, 20));
        return TimeSpan.FromSeconds(Math.Min(seconds, ceiling.TotalSeconds));
    }

    private static DbContext ResolveContext(IServiceScope scope, OutboxModuleRegistration module)
    {
        var context = (DbContext)scope.ServiceProvider.GetRequiredService(module.ContextType);

        // O schema do SQL é o do registro: se o modelo disser outro, é erro de composição, não de runtime.
        var modelSchema = context.Model.GetDefaultSchema();
        if (!string.Equals(modelSchema, module.Schema, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"O schema do modelo ('{modelSchema}') difere do registrado para a outbox do módulo '{module.ModuleKey}' ('{module.Schema}').");
        }

        return context;
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Falha na varredura da outbox do módulo {Module}.")]
    private partial void LogSweepFailed(Exception exception, string module);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Entrega do evento {EventId} ({EventType}) falhou na tentativa {Attempts}: {Error}.")]
    private partial void LogDeliveryFailed(Guid eventId, string eventType, int attempts, string error);

    private sealed class UnknownEventTypeException : Exception;
}
