using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>
/// Sinal em processo "há mensagem nova na outbox deste módulo". Substitui o polling curto: o banco do plano
/// gratuito só pode acordar quando há trabalho. Cheio, descarta (DropWrite): a varredura de reserva cobre.
/// </summary>
public sealed class OutboxSignal
{
    private readonly Channel<ModuleKey> _channel = Channel.CreateBounded<ModuleKey>(
        new BoundedChannelOptions(1024) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

    internal ChannelReader<ModuleKey> Reader => _channel.Reader;

    public void Notify(ModuleKey module) => _channel.Writer.TryWrite(module);
}

/// <summary>
/// Avisa o despachante depois que uma gravação com mensagem de outbox foi confirmada. Se o caso de uso usa uma
/// transação explícita, o aviso espera o commit (avisar antes faria o despachante olhar uma linha ainda
/// invisível e voltar a dormir); rollback descarta o aviso.
/// </summary>
internal sealed class OutboxSignalInterceptor(OutboxSignal signal, OutboxModuleRegistry modules)
    : SaveChangesInterceptor, IDbTransactionInterceptor
{
    private sealed class Pending
    {
        public bool HasOutbox { get; set; }
    }

    // Estado por contexto (e não por instância do interceptor, que é único): a tabela solta o contexto junto com ele.
    private readonly ConditionalWeakTable<DbContext, Pending> _pending = [];

    public override InterceptionResult<int> SavingChanges(DbContextEventData eventData, InterceptionResult<int> result)
    {
        Mark(eventData);
        return base.SavingChanges(eventData, result);
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        Mark(eventData);
        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    public override int SavedChanges(SaveChangesCompletedEventData eventData, int result)
    {
        AfterSave(eventData);
        return base.SavedChanges(eventData, result);
    }

    public override ValueTask<int> SavedChangesAsync(
        SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
    {
        AfterSave(eventData);
        return base.SavedChangesAsync(eventData, result, cancellationToken);
    }

    public override void SaveChangesFailed(DbContextErrorEventData eventData) => Clear(eventData.Context);

    public override Task SaveChangesFailedAsync(DbContextErrorEventData eventData, CancellationToken cancellationToken = default)
    {
        Clear(eventData.Context);
        return Task.CompletedTask;
    }

    public void TransactionCommitted(DbTransaction transaction, TransactionEndEventData eventData) => NotifyIfPending(eventData.Context);

    public Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        NotifyIfPending(eventData.Context);
        return Task.CompletedTask;
    }

    public void TransactionRolledBack(DbTransaction transaction, TransactionEndEventData eventData) => Clear(eventData.Context);

    public Task TransactionRolledBackAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        Clear(eventData.Context);
        return Task.CompletedTask;
    }

    private void Mark(DbContextEventData eventData)
    {
        var context = eventData.Context;
        if (context is null || modules.FindByContext(context.GetType()) is null)
        {
            return;
        }

        if (context.ChangeTracker.Entries<OutboxMessage>().Any(e => e.State == EntityState.Added))
        {
            _pending.GetOrCreateValue(context).HasOutbox = true;
        }
    }

    private void AfterSave(DbContextEventData eventData)
    {
        var context = eventData.Context;
        if (context is null || !_pending.TryGetValue(context, out var pending) || !pending.HasOutbox)
        {
            return;
        }

        // Dentro de uma transação explícita o dado ainda não está visível: o aviso sai no commit.
        if (context.Database.CurrentTransaction is null)
        {
            NotifyIfPending(context);
        }
    }

    private void NotifyIfPending(DbContext? context)
    {
        if (context is null || !_pending.TryGetValue(context, out var pending) || !pending.HasOutbox)
        {
            return;
        }

        pending.HasOutbox = false;
        var registration = modules.FindByContext(context.GetType());
        if (registration is not null)
        {
            signal.Notify(new ModuleKey(registration.ModuleKey));
        }
    }

    private void Clear(DbContext? context)
    {
        if (context is not null && _pending.TryGetValue(context, out var pending))
        {
            pending.HasOutbox = false;
        }
    }
}
