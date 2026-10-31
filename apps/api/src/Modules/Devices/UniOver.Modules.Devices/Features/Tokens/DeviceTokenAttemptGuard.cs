using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace UniOver.Modules.Devices.Features.Tokens;

/// <summary>
/// Limita as consultas ao banco por token inválido, por origem. Cada token inexistente ou revogado custa uma consulta, e
/// quem manda tokens aleatórios sem parar mantém o compute do Neon gratuito acordado e gasta as horas do plano. O limite
/// é por IP (o que o Host já resolve atrás do proxy) e só conta FALHAS: o agente certo, com o token no cache, nunca passa por aqui.
/// </summary>
public interface IDeviceTokenAttemptGuard
{
    /// <summary>Esta origem já estourou o teto de falhas na janela? Se sim, a consulta ao banco nem acontece.</summary>
    bool IsBlocked(string clientKey, out TimeSpan retryAfter);

    /// <summary>Anota uma falha (token inexistente ou revogado) desta origem.</summary>
    void RecordFailure(string clientKey);
}

/// <summary>
/// Contadores em processo, janela fixa por origem. Zeram quando o serviço dorme ou é reimplantado, o que é aceitável: o
/// objetivo é só impedir que uma rajada vire consulta ao banco. A tabela é limitada: cheia e sem nada vencido para varrer,
/// a origem nova deixa de ser contada (falha aberta) em vez de a memória crescer sem fim.
/// </summary>
internal sealed class InMemoryDeviceTokenAttemptGuard(TimeProvider time, IOptions<DevicesModuleOptions> options) : IDeviceTokenAttemptGuard
{
    internal const int MaxTrackedClients = 20_000;

    private readonly ConcurrentDictionary<string, Window> _windows = new(StringComparer.Ordinal);

    private sealed class Window(DateTimeOffset startedAt)
    {
        public DateTimeOffset StartedAt { get; set; } = startedAt;

        public int Failures { get; set; }
    }

    internal int TrackedClients => _windows.Count;

    public bool IsBlocked(string clientKey, out TimeSpan retryAfter)
    {
        retryAfter = TimeSpan.Zero;
        var settings = options.Value;
        if (!_windows.TryGetValue(clientKey, out var window))
        {
            return false;
        }

        var now = time.GetUtcNow();
        lock (window)
        {
            if (now - window.StartedAt >= settings.TokenFailureWindow)
            {
                return false;
            }

            if (window.Failures < settings.TokenFailureLimit)
            {
                return false;
            }

            retryAfter = window.StartedAt + settings.TokenFailureWindow - now;
            return true;
        }
    }

    public void RecordFailure(string clientKey)
    {
        var settings = options.Value;
        var now = time.GetUtcNow();

        if (!_windows.TryGetValue(clientKey, out var window))
        {
            if (_windows.Count >= MaxTrackedClients)
            {
                Sweep(now, settings.TokenFailureWindow);
                if (_windows.Count >= MaxTrackedClients)
                {
                    return;
                }
            }

            window = _windows.GetOrAdd(clientKey, _ => new Window(now));
        }

        lock (window)
        {
            if (now - window.StartedAt >= settings.TokenFailureWindow)
            {
                window.StartedAt = now;
                window.Failures = 0;
            }

            window.Failures++;
        }
    }

    private void Sweep(DateTimeOffset now, TimeSpan lifetime)
    {
        foreach (var (key, window) in _windows)
        {
            bool expired;
            lock (window)
            {
                expired = now - window.StartedAt >= lifetime;
            }

            if (expired)
            {
                _windows.TryRemove(key, out _);
            }
        }
    }
}
