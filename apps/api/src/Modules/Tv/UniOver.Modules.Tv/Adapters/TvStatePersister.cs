using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Grava no banco as mudanças de <c>power</c>, <c>app</c> e <c>connection</c> (e só elas), juntando oscilações
/// rápidas: a primeira mudança agenda UMA gravação para daqui a poucos segundos e, quando ela roda, vale o estado
/// mais recente. Não há laço periódico (cada gravação nasce de uma mensagem do agente), então o Neon só acorda
/// quando o estado de fato mudou. O evento <c>tv.state-changed.v1</c> sai na outbox, na mesma transação da gravação.
/// </summary>
internal sealed partial class TvStatePersister(
    IServiceScopeFactory scopes,
    IOptions<TvModuleOptions> options,
    TimeProvider time,
    IHostApplicationLifetime lifetime,
    ILogger<TvStatePersister> logger)
{
    private readonly object _gate = new();
    private readonly Dictionary<string, TvStateSnapshot> _persisted = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TvStateSnapshot> _pending = new(StringComparer.Ordinal);
    private readonly HashSet<string> _scheduled = new(StringComparer.Ordinal);

    /// <summary>Chamado a cada estado novo do agente; só agenda gravação se algo gravável mudou.</summary>
    public void Observe(string agentId, TvStateSnapshot snapshot)
    {
        lock (_gate)
        {
            _pending[agentId] = snapshot;
            if (snapshot.SamePersistedFieldsAs(_persisted.GetValueOrDefault(agentId)) || !_scheduled.Add(agentId))
            {
                return;
            }
        }

        // A gravação roda fora da mensagem do agente: a leitura dele não espera pelo banco.
        _ = Task.Run(() => FlushAfterDelayAsync(agentId), CancellationToken.None);
    }

    private async Task FlushAfterDelayAsync(string agentId)
    {
        try
        {
            var stopping = lifetime.ApplicationStopping;
            while (true)
            {
                await Task.Delay(options.Value.StateDebounce, time, stopping);

                TvStateSnapshot target;
                lock (_gate)
                {
                    var pending = _pending[agentId];
                    if (pending.SamePersistedFieldsAs(_persisted.GetValueOrDefault(agentId)))
                    {
                        // Oscilou e voltou ao que já estava gravado: nada a escrever.
                        _scheduled.Remove(agentId);
                        return;
                    }

                    target = pending;
                }

                await WriteAsync(agentId, target, stopping);
                lock (_gate)
                {
                    _persisted[agentId] = target;
                }

                // Uma mudança que chegou durante a gravação é conferida (e gravada) na volta do laço.
            }
        }
        catch (OperationCanceledException)
        {
            // A aplicação está parando: o próximo estado do agente refaz a gravação.
        }
#pragma warning disable CA1031 // Falha ao gravar estado não pode derrubar nada: registra e tenta na próxima mudança.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogFlushFailed(agentId, ex.GetType().Name);
            lock (_gate)
            {
                _scheduled.Remove(agentId);
            }
        }
    }

    private async Task WriteAsync(string agentId, TvStateSnapshot snapshot, CancellationToken cancellationToken)
    {
        // Escopo próprio: a gravação e o evento da outbox usam o mesmo DbContext e saem num único SaveChanges.
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TvDbContext>();
        var events = scope.ServiceProvider.GetRequiredService<IEventBus>();

        var record = await db.States.SingleOrDefaultAsync(s => s.AgentId == agentId, cancellationToken);
        if (record is not null && record.Matches(snapshot))
        {
            // Já está gravado (o cache em memória nasceu vazio depois de um reinício): nem escrita, nem evento.
            return;
        }

        if (record is null)
        {
            db.States.Add(TvStateRecord.Create(agentId, snapshot));
        }
        else
        {
            record.Update(snapshot);
        }

        await events.PublishAsync(
            new TvStateChanged(
                IdGenerator.NewId(), time.GetUtcNow(), agentId, snapshot.Power, snapshot.App, snapshot.Connection, snapshot.UpdatedAt),
            cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
    }

    // Só o tipo do erro: a mensagem do driver do banco pode citar o servidor e a conexão.
    [LoggerMessage(Level = LogLevel.Error, Message = "Falha ao gravar o estado da TV do agente {AgentId} ({ErrorType}).")]
    private partial void LogFlushFailed(string agentId, string errorType);
}
