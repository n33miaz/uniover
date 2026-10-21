using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Junta o relatório da limpeza ao pedido que o espera. Uma limpeza por vez: a TV é uma só, e duas juntas disputariam
/// o ADB do agente. É da instância (singleton do módulo), nunca estático, e some quando a API reinicia.
/// </summary>
internal sealed class InMemoryTvCleanupReports(TimeProvider time) : ITvCleanupReports
{
    private readonly object _gate = new();
    private Guid? _activeId;
    private TaskCompletionSource<TvCleanupReport>? _activeReport;

    public ITvCleanupTicket? TryBegin()
    {
        lock (_gate)
        {
            if (_activeId is not null)
            {
                return null;
            }

            _activeId = IdGenerator.NewId();
            _activeReport = new TaskCompletionSource<TvCleanupReport>(TaskCreationOptions.RunContinuationsAsynchronously);
            return new Ticket(this, _activeId.Value, _activeReport.Task, time);
        }
    }

    public void Complete(Guid requestId, TvCleanupReport report)
    {
        ArgumentNullException.ThrowIfNull(report);

        // Só vale o relatório do pedido em andamento: o de uma limpeza que já desistiu de esperar não confunde a seguinte.
        lock (_gate)
        {
            if (_activeId == requestId)
            {
                _activeReport?.TrySetResult(report);
            }
        }
    }

    private void Release(Guid requestId)
    {
        lock (_gate)
        {
            if (_activeId == requestId)
            {
                _activeId = null;
                _activeReport = null;
            }
        }
    }

    private sealed class Ticket(InMemoryTvCleanupReports owner, Guid requestId, Task<TvCleanupReport> report, TimeProvider time) : ITvCleanupTicket
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

        public void Dispose() => owner.Release(RequestId);
    }
}
