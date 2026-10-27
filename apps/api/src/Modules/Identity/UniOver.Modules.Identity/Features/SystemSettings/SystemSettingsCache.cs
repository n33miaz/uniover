namespace UniOver.Modules.Identity.Features.SystemSettings;

/// <summary>
/// Cache curto por chave com uma geração por chave: quem lê captura a geração antes de ir ao banco e só guarda o
/// resultado se ela não mudou; <see cref="Invalidate"/> a incrementa. Assim uma leitura em voo que começou antes da
/// gravação não repõe o valor velho depois da invalidação. O cache é por instância (memória do processo) porque a API
/// roda numa instância só; com várias, a invalidação não chegaria às outras e o TTL de 15 s passaria a ser a única
/// garantia, então o cache teria de sair do processo.
/// </summary>
internal sealed class SystemSettingsCache(TimeProvider time, TimeSpan lifetime)
{
    private readonly Dictionary<string, (string? Json, DateTimeOffset Until)> _entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _generations = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public async Task<string?> GetAsync(string key, Func<CancellationToken, Task<string?>> load, CancellationToken cancellationToken)
    {
        long generation;
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var item) && item.Until > time.GetUtcNow()) return item.Json;
            generation = _generations.GetValueOrDefault(key);
        }

        var json = await load(cancellationToken);

        lock (_gate)
        {
            if (_generations.GetValueOrDefault(key) == generation) _entries[key] = (json, time.GetUtcNow().Add(lifetime));
        }
        return json;
    }

    public void Invalidate(string key)
    {
        lock (_gate)
        {
            _generations[key] = _generations.GetValueOrDefault(key) + 1;
            _entries.Remove(key);
        }
    }
}
