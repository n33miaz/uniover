using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// O <see cref="ITvAgentResolver"/>: banco, depois a variável de ambiente, depois nada. Singleton, com o valor guardado
/// por pouco tempo (o mesmo teto de 30 s das permissões) e trocado na hora por quem salva; o prazo só cobre uma mudança
/// feita por fora do processo. Uma leitura por vez: várias chamadas ao mesmo tempo esperam a primeira em vez de
/// repetirem a consulta.
/// </summary>
internal sealed partial class TvAgentResolver(
    ISavedTvReader saved,
    IOptions<TvModuleOptions> options,
    TimeProvider time,
    ILogger<TvAgentResolver> logger) : ITvAgentResolver, IDisposable
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(30);

    /// <summary>Com o banco fora do ar, tenta de novo logo (e não só ao fim do prazo inteiro).</summary>
    public static readonly TimeSpan RetryAfterFailure = TimeSpan.FromSeconds(5);

    private readonly SemaphoreSlim _loading = new(1, 1);
    private volatile Cached? _cached;

    // Cada Set/Invalidate muda a geração; uma leitura que começou antes e termina depois não sobrescreve o valor novo.
    private long _generation;

    private sealed record Cached(TvAgentBinding Binding, DateTimeOffset ValidUntil);

    public ValueTask<TvAgentBinding> ResolveAsync(CancellationToken cancellationToken)
    {
        if (_cached is { } cached && time.GetUtcNow() < cached.ValidUntil)
        {
            return ValueTask.FromResult(cached.Binding);
        }

        return new ValueTask<TvAgentBinding>(LoadAsync(cancellationToken));
    }

    public bool TryGetLast([NotNullWhen(true)] out TvAgentBinding? binding)
    {
        binding = _cached?.Binding;
        return binding is not null;
    }

    public void Set(TvAgentBinding binding)
    {
        ArgumentNullException.ThrowIfNull(binding);
        Interlocked.Increment(ref _generation);
        _cached = new Cached(binding, time.GetUtcNow() + Lifetime);
    }

    public void Dispose() => _loading.Dispose();

    public void Invalidate()
    {
        Interlocked.Increment(ref _generation);
        _cached = null;
    }

    private async Task<TvAgentBinding> LoadAsync(CancellationToken cancellationToken)
    {
        await _loading.WaitAsync(cancellationToken);
        try
        {
            // Quem esperava a vez já encontra o valor que a leitura anterior deixou.
            if (_cached is { } cached && time.GetUtcNow() < cached.ValidUntil)
            {
                return cached.Binding;
            }

            var generation = Volatile.Read(ref _generation);
            TvAgentBinding binding;
            DateTimeOffset validUntil;
            try
            {
                var row = await saved.ReadDefaultAsync(cancellationToken);
                binding = row is null ? FromEnvironment() : new TvAgentBinding(row.AgentSlug, row.Name, TvAgentSource.Saved);
                validUntil = time.GetUtcNow() + Lifetime;
            }
#pragma warning disable CA1031 // Banco fora do ar não pode parar a TV: segue com o que já se sabia (ou com a variável).
            catch (Exception ex) when (ex is not OperationCanceledException)
#pragma warning restore CA1031
            {
                LogReadFailed(ex);
                binding = _cached?.Binding ?? FromEnvironment();
                validUntil = time.GetUtcNow() + RetryAfterFailure;
            }

            if (Volatile.Read(ref _generation) == generation)
            {
                _cached = new Cached(binding, validUntil);
            }

            return binding;
        }
        finally
        {
            _loading.Release();
        }
    }

    private TvAgentBinding FromEnvironment() =>
        string.IsNullOrWhiteSpace(options.Value.AgentId)
            ? TvAgentBinding.NotConfigured
            : new TvAgentBinding(options.Value.AgentId, ConfiguredTv.DefaultName, TvAgentSource.Environment);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível ler o computador da TV no banco; seguindo com o último valor conhecido ou com a variável de ambiente.")]
    private partial void LogReadFailed(Exception exception);
}
