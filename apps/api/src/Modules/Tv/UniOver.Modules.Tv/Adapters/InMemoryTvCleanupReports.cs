using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Junta o relatório da limpeza ao pedido que o espera. Há uma limpeza por TV: duas na mesma disputariam o agente, mas
/// TVs diferentes não compartilham ADB. É da instância (singleton do módulo), nunca estático, e some quando a API reinicia.
/// </summary>
internal sealed class InMemoryTvCleanupReports(TimeProvider time) : ITvCleanupReports
{
    private readonly object _gate = new();
    private readonly Dictionary<Guid, ActiveReport> _active = [];

    public ITvCleanupTicket? TryBegin(Guid tvId)
    {
        lock (_gate)
        {
            if (_active.ContainsKey(tvId))
            {
                return null;
            }

            var active = new ActiveReport(IdGenerator.NewId());
            _active.Add(tvId, active);
            return new Ticket(this, tvId, active.RequestId, active.Completion.Task, time);
        }
    }

    public void Complete(Guid tvId, Guid requestId, TvCleanupReport report)
    {
        ArgumentNullException.ThrowIfNull(report);

        // Só vale o relatório do pedido em andamento: o de uma limpeza que já desistiu de esperar não confunde a seguinte.
        lock (_gate)
        {
            if (_active.TryGetValue(tvId, out var active) && active.RequestId == requestId)
            {
                active.Completion.TrySetResult(report);
            }
        }
    }

    private void Release(Guid tvId, Guid requestId)
    {
        lock (_gate)
        {
            if (_active.TryGetValue(tvId, out var active) && active.RequestId == requestId)
            {
                _active.Remove(tvId);
            }
        }
    }

    private sealed class ActiveReport(Guid requestId)
    {
        public Guid RequestId { get; } = requestId;

        public TaskCompletionSource<TvCleanupReport> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed class Ticket(InMemoryTvCleanupReports owner, Guid tvId, Guid requestId, Task<TvCleanupReport> report, TimeProvider time) : ITvCleanupTicket
    {
        public Guid RequestId { get; } = requestId;

        public async Task<TvCleanupReport?> WaitAsync(TimeSpan grace, CancellationToken cancellationToken)
        {
            if (report.IsCompletedSuccessfully)
            {
                return report.Result;
            }

            try
            {
                return await report.WaitAsync(grace, time, cancellationToken);
            }
            catch (TimeoutException)
            {
                return null;
            }
        }

        public void Dispose() => owner.Release(tvId, RequestId);
    }
}
