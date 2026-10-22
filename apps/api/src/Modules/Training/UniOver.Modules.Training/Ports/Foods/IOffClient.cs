using System.Net;

namespace UniOver.Modules.Training.Ports.Foods;

public sealed record OffFoodData(string Barcode, string Name, string? Brand, decimal Kcal, decimal Protein, decimal Carbs, decimal Fat);
public sealed record OffSearchPage(IReadOnlyList<OffFoodData> Items);

public sealed class OffUpstreamException(HttpStatusCode statusCode, int retryAfterSeconds) : Exception
{
    public HttpStatusCode StatusCode { get; } = statusCode;
    public int RetryAfterSeconds { get; } = Math.Max(1, retryAfterSeconds);
}

public interface IOffClient
{
    Task<OffSearchPage> SearchAsync(string query, CancellationToken cancellationToken);
    Task<OffFoodData?> LookupAsync(string barcode, CancellationToken cancellationToken);
}

public enum OffRateDecision { Allowed, Limited }

/// <summary>Budget por processo: mantém margem sob os limites publicados pelo OFF (10 buscas/15 leituras por minuto).</summary>
public sealed class OffRateLimiter(TimeProvider time)
{
    private readonly object _sync = new();
    private readonly Queue<DateTimeOffset> _searches = new();
    private readonly Queue<DateTimeOffset> _lookups = new();

    public bool TryAcquire(bool search, out int retryAfterSeconds)
    {
        lock (_sync)
        {
            var now = time.GetUtcNow();
            var queue = search ? _searches : _lookups;
            while (queue.Count > 0 && now - queue.Peek() >= TimeSpan.FromMinutes(1)) queue.Dequeue();
            var cap = search ? 8 : 12;
            if (queue.Count >= cap)
            {
                retryAfterSeconds = Math.Max(1, (int)Math.Ceiling((TimeSpan.FromMinutes(1) - (now - queue.Peek())).TotalSeconds));
                return false;
            }

            queue.Enqueue(now);
            retryAfterSeconds = 0;
            return true;
        }
    }
}
