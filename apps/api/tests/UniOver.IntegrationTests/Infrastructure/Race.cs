namespace UniOver.IntegrationTests.Infrastructure;

/// <summary>
/// Largada conjunta para testes de corrida: todos os concorrentes chegam à barreira e só então são liberados no mesmo
/// instante. A barreira tira a dependência de tempo (nenhuma espera fixa); o número de concorrentes mantém a pressão.
/// </summary>
public static class Race
{
    private static readonly TimeSpan Limit = TimeSpan.FromSeconds(30);

    public static async Task<T[]> RunTogetherAsync<T>(int count, Func<int, Task<T>> work, CancellationToken ct)
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var allReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var ready = 0;

        async Task<T> RunAsync(int index)
        {
            if (Interlocked.Increment(ref ready) == count)
            {
                allReady.TrySetResult();
            }

            await release.Task.WaitAsync(Limit, ct);
            return await work(index);
        }

        var runs = Enumerable.Range(0, count).Select(i => Task.Run(() => RunAsync(i), ct)).ToArray();
        await allReady.Task.WaitAsync(Limit, ct);
        release.TrySetResult();
        return await Task.WhenAll(runs);
    }
}
