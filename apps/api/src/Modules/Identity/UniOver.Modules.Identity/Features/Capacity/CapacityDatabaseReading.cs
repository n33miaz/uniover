using UniOver.BuildingBlocks.Persistence;

namespace UniOver.Modules.Identity.Features.Capacity;

/// <summary>
/// Guarda por alguns minutos a última medida do banco. <c>pg_database_size</c> e <c>pg_total_relation_size</c> varrem o
/// catálogo e acordam o banco gratuito, então o cartão não os repete a cada leitura nem a cada toque em "Atualizar": a
/// leitura devolve também o instante da medida, para a tela não fingir que é de agora. Uma só medida por vez, mesmo com
/// várias leituras ao mesmo tempo. A amostra diária não passa por aqui: ela mede de verdade.
/// </summary>
internal sealed class CapacityDatabaseReading(TimeProvider time) : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DatabaseSize? _size;
    private DateTimeOffset _measuredAt;

    public async Task<(DatabaseSize Size, DateTimeOffset MeasuredAt)> GetAsync(
        TimeSpan lifetime, Func<CancellationToken, Task<DatabaseSize>> measure, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(measure);

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var now = time.GetUtcNow();
            if (_size is not null && lifetime > TimeSpan.Zero && now - _measuredAt < lifetime)
            {
                return (_size, _measuredAt);
            }

            // Uma medida que falha não fica guardada: a próxima leitura tenta de novo.
            var size = await measure(cancellationToken);
            _size = size;
            _measuredAt = now;
            return (size, now);
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();
}
