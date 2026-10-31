using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Junta a lista de TVs achadas ao pedido que a espera. É da instância (singleton do módulo), nunca estático, e some
/// quando a API reinicia. Só vale a lista do pedido em andamento: a de uma procura que já desistiu não confunde a seguinte.
/// </summary>
internal sealed class InMemoryTvDiscoveryReports(TimeProvider time) : ITvDiscoveryReports
{
    private readonly object _gate = new();
    private readonly Dictionary<string, Active> _active = new(StringComparer.Ordinal);

    public ITvDiscoveryTicket? TryBegin(string agentId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentId);
        lock (_gate)
        {
            if (_active.ContainsKey(agentId))
            {
                return null;
            }

            var active = new Active(IdGenerator.NewId());
            _active.Add(agentId, active);
            return new Ticket(this, agentId, active.RequestId, active.Completion.Task, time);
        }
    }

    public void Complete(string agentId, Guid requestId, IReadOnlyList<TvNearby> tvs)
    {
        ArgumentNullException.ThrowIfNull(tvs);
        lock (_gate)
        {
            if (_active.TryGetValue(agentId, out var active) && active.RequestId == requestId)
            {
                active.Completion.TrySetResult(tvs);
            }
        }
    }

    private void Release(string agentId, Guid requestId)
    {
        lock (_gate)
        {
            if (_active.TryGetValue(agentId, out var active) && active.RequestId == requestId)
            {
                _active.Remove(agentId);
            }
        }
    }

    private sealed class Active(Guid requestId)
    {
        public Guid RequestId { get; } = requestId;

        public TaskCompletionSource<IReadOnlyList<TvNearby>> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed class Ticket(
        InMemoryTvDiscoveryReports owner, string agentId, Guid requestId, Task<IReadOnlyList<TvNearby>> list, TimeProvider time)
        : ITvDiscoveryTicket
    {
        public Guid RequestId { get; } = requestId;

        public async Task<IReadOnlyList<TvNearby>?> WaitAsync(TimeSpan grace, CancellationToken cancellationToken)
        {
            if (list.IsCompletedSuccessfully)
            {
                return list.Result;
            }

            try
            {
                return await list.WaitAsync(grace, time, cancellationToken);
            }
            catch (TimeoutException)
            {
                return null;
            }
        }

        public void Dispose() => owner.Release(agentId, RequestId);
    }
}
