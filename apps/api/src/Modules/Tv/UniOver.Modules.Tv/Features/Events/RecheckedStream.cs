using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Tv.Features.Events;

/// <summary>
/// Reavalia o acesso enquanto o fluxo está aberto e o fecha quando deixou de valer. O laço do SSE só confere o acesso
/// quando fica ocioso até o keep-alive; com eventos chegando em intervalos menores que isso (a TV em uso) essa conferência
/// nunca rodaria, e quem perdeu a permissão seguiria recebendo o estado da TV até o fim do fluxo. Este vigia roda por
/// relógio próprio, independente do tráfego: a cada <c>interval</c> pergunta de novo, pelo mesmo caminho (e o mesmo
/// cache curto) da política da rota. Sem conseguir perguntar, nega: o fluxo fecha (falha fechada).
/// </summary>
internal sealed class RecheckedStream<T>(
    IResult inner,
    SseSubscription<T> subscription,
    Func<CancellationToken, Task<bool>> stillAllowed,
    TimeSpan interval,
    TimeProvider time) : IResult
{
    public async Task ExecuteAsync(HttpContext httpContext)
    {
        ArgumentNullException.ThrowIfNull(httpContext);

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(httpContext.RequestAborted);
        var watcher = WatchAsync(stop.Token);
        try
        {
            await inner.ExecuteAsync(httpContext);
        }
        finally
        {
            await stop.CancelAsync();
            await watcher;
        }
    }

    private async Task WatchAsync(CancellationToken token)
    {
        try
        {
            using var timer = new PeriodicTimer(interval, time);
            while (await timer.WaitForNextTickAsync(token))
            {
                if (!await IsAllowedAsync(token))
                {
                    // Fechar a fila faz o laço do SSE terminar: nada mais é escrito para quem perdeu o acesso.
                    subscription.Close();
                    return;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Fim normal: o fluxo terminou (cliente saiu, aplicação parando ou duração máxima).
        }
    }

    private async Task<bool> IsAllowedAsync(CancellationToken token)
    {
        try
        {
            return await stillAllowed(token);
        }
#pragma warning disable CA1031 // Falha fechada: sem conseguir conferir o acesso, o fluxo fecha.
        catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested)
#pragma warning restore CA1031
        {
            // Só o cancelamento do próprio fluxo é fim normal; um cancelamento de fora (tempo esgotado do banco, por exemplo)
            // também é "não deu para conferir" e fecha o fluxo.
            return false;
        }
    }
}
