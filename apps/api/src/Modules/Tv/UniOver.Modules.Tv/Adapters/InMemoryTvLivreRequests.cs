using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Como <see cref="InMemoryTvCleanupReports"/>, para o TV Livre: um passo por TV, e o aviso de que o estado do pedido já
/// foi guardado. O estado em si vai para o banco antes do aviso, então quem acorda lê o dado definitivo e não uma cópia.
/// É da instância (singleton do módulo), nunca estático, e some quando a API reinicia.
/// </summary>
internal sealed class InMemoryTvLivreRequests(TimeProvider time) : ITvLivreRequests
{
    private readonly object _gate = new();
    private readonly Dictionary<Guid, Active> _active = [];

    public ITvLivreTicket? TryBegin(Guid tvId)
    {
        lock (_gate)
        {
            if (_active.ContainsKey(tvId))
            {
                return null;
            }

            var active = new Active(IdGenerator.NewId());
            _active.Add(tvId, active);
            return new Ticket(this, tvId, active, time);
        }
    }

    public void StateStored(Guid tvId, Guid requestId)
    {
        // Só vale o estado do pedido em andamento: o de um passo que já desistiu de esperar não confunde o seguinte.
        lock (_gate)
        {
            if (_active.TryGetValue(tvId, out var active) && active.RequestId == requestId)
            {
                active.Stored.TrySetResult();
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

    private sealed class Active(Guid requestId)
    {
        public Guid RequestId { get; } = requestId;

        public TaskCompletionSource Stored { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed class Ticket(InMemoryTvLivreRequests owner, Guid tvId, Active active, TimeProvider time) : ITvLivreTicket
    {
        public Guid RequestId { get; } = active.RequestId;

        public async Task<bool> WaitForStateAsync(TimeSpan grace, CancellationToken cancellationToken)
        {
            if (active.Stored.Task.IsCompletedSuccessfully)
            {
                return true;
            }

            try
            {
                await active.Stored.Task.WaitAsync(grace, time, cancellationToken);
                return true;
            }
            catch (TimeoutException)
            {
                return false;
            }
        }

        public void Dispose() => owner.Release(tvId, RequestId);
    }
}
