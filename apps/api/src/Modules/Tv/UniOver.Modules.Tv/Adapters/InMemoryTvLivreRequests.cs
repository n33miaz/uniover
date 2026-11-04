using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// A vez por TV só dentro desta instância: serve a quem não tem PostgreSQL por baixo (testes de unidade) e é o que
/// <see cref="TvLivreRequests"/> usa nesse caso. Com o banco de verdade a vez é a trava consultiva dele, que vale entre
/// instâncias. É da instância (nunca estático) e some quando a API reinicia.
/// </summary>
internal sealed class InMemoryTvLivreRequests : ITvLivreRequests
{
    private readonly object _gate = new();
    private readonly Dictionary<Guid, Guid> _active = [];

    public Task<ITvLivreTicket?> TryBeginAsync(Guid tvId, CancellationToken cancellationToken) =>
        Task.FromResult<ITvLivreTicket?>(TryBegin(tvId));

    public ITvLivreTicket? TryBegin(Guid tvId)
    {
        lock (_gate)
        {
            if (_active.ContainsKey(tvId))
            {
                return null;
            }

            var requestId = IdGenerator.NewId();
            _active.Add(tvId, requestId);
            return new Ticket(this, tvId, requestId);
        }
    }

    private void Release(Guid tvId, Guid requestId)
    {
        // Só quem tem a vez a devolve: um bilhete velho descartado de novo nunca solta a vez de um passo mais novo.
        lock (_gate)
        {
            if (_active.TryGetValue(tvId, out var current) && current == requestId)
            {
                _active.Remove(tvId);
            }
        }
    }

    private sealed class Ticket(InMemoryTvLivreRequests owner, Guid tvId, Guid requestId) : ITvLivreTicket
    {
        public Guid RequestId { get; } = requestId;

        public ValueTask DisposeAsync()
        {
            owner.Release(tvId, RequestId);
            return ValueTask.CompletedTask;
        }
    }
}
