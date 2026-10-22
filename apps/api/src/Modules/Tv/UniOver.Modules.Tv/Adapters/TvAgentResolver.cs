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
/// <para>
/// A variável de ambiente só vale quando o banco foi lido COM SUCESSO e não tinha linha. Banco fora do ar sem nenhum valor
/// conhecido (logo depois da partida, ou depois de <see cref="Invalidate"/>) NÃO cai na variável: ela pode apontar o
/// computador de antes da troca feita no app, que segue pareado, e teclas e texto digitado (até a senha da TV) iriam para
/// ele. Nesse caso o resultado é "não configurado" (os comandos respondem 503) e a leitura é tentada de novo em poucos
/// segundos.
/// </para>
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

    /// <param name="FromDatabase">
    /// O valor veio de uma leitura bem-sucedida do banco (ou de quem acabou de salvar). Falso é só o "não configurado" que
    /// vale pelos poucos segundos depois de uma leitura que falhou sem nada conhecido: não conta como valor conhecido.
    /// </param>
    private sealed record Cached(TvAgentBinding Binding, DateTimeOffset ValidUntil, bool FromDatabase);

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
        binding = _cached is { FromDatabase: true } known ? known.Binding : null;
        return binding is not null;
    }

    public void Set(TvAgentBinding binding)
    {
        ArgumentNullException.ThrowIfNull(binding);
        Interlocked.Increment(ref _generation);
        _cached = new Cached(binding, time.GetUtcNow() + Lifetime, FromDatabase: true);
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
            bool fromDatabase;
            try
            {
                var row = await saved.ReadDefaultAsync(cancellationToken);
                binding = row is null ? FromEnvironment() : new TvAgentBinding(row.AgentSlug, row.Name, TvAgentSource.Saved);
                validUntil = time.GetUtcNow() + Lifetime;
                fromDatabase = true;
            }
#pragma warning disable CA1031 // Banco fora do ar não pode parar a TV que já se conhece; sem nada conhecido, ninguém é escolhido às cegas.
            catch (Exception ex) when (ex is not OperationCanceledException)
#pragma warning restore CA1031
            {
                LogReadFailed(ex.GetType().Name);

                // Só o que já veio do banco com sucesso serve de reserva. A variável de ambiente NÃO: ela nunca foi confrontada
                // com a linha salva e pode ser o computador de antes da troca.
                var known = _cached is { FromDatabase: true } last ? last : null;
                binding = known?.Binding ?? TvAgentBinding.NotConfigured;
                fromDatabase = known is not null;
                validUntil = time.GetUtcNow() + RetryAfterFailure;
            }

            if (Volatile.Read(ref _generation) == generation)
            {
                _cached = new Cached(binding, validUntil, fromDatabase);
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

    // Só o tipo do erro: a mensagem do driver pode citar o servidor e a conexão.
    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível ler o computador da TV no banco ({ErrorType}); seguindo com o último valor conhecido ou, se não houver, sem computador configurado.")]
    private partial void LogReadFailed(string errorType);
}
