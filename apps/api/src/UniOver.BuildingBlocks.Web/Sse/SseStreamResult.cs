using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Escreve um <see cref="SseSubscription{T}"/> como <c>text/event-stream</c>. Termina quando o cliente sai, quando
/// a aplicação vai parar ou quando a duração máxima passa. O keep-alive é um comentário SSE (linha iniciada por
/// dois pontos), que o navegador ignora; o <c>SseItem</c> do .NET não tem como emitir comentário, por isso a
/// escrita é feita aqui. Com <c>stillAllowed</c> o acesso é conferido a cada keep-alive e o fluxo fecha se deixou de valer.
/// Todo o tempo passa pelo <see cref="TimeProvider"/>, para os testes controlarem.
/// </summary>
public static class SseResults
{
    private static readonly UTF8Encoding Utf8 = new(false);

    public static IResult Stream<T>(
        SseSubscription<T> subscription,
        SseStreamOptions options,
        TimeProvider time,
        CancellationToken applicationStopping) =>
        new SseStreamResult<T>(subscription, options, time, null, applicationStopping);

    /// <param name="stillAllowed">Conferida a cada keep-alive: se devolver <c>false</c> o fluxo é encerrado (acesso revogado).</param>
    public static IResult Stream<T>(
        SseSubscription<T> subscription,
        SseStreamOptions options,
        TimeProvider time,
        Func<CancellationToken, Task<bool>>? stillAllowed,
        CancellationToken applicationStopping) =>
        new SseStreamResult<T>(subscription, options, time, stillAllowed, applicationStopping);

    private sealed class SseStreamResult<T>(
        SseSubscription<T> subscription,
        SseStreamOptions options,
        TimeProvider time,
        Func<CancellationToken, Task<bool>>? stillAllowed,
        CancellationToken applicationStopping) : IResult
    {
        public async Task ExecuteAsync(HttpContext httpContext)
        {
            ArgumentNullException.ThrowIfNull(httpContext);

            var response = httpContext.Response;
            response.ContentType = "text/event-stream";
            response.Headers.CacheControl = "no-cache";

            // Sem isto um proxy na frente pode segurar os eventos até encher um buffer.
            response.Headers["X-Accel-Buffering"] = "no";
            httpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

            using var lifetime = new CancellationTokenSource(options.MaxLifetime, time);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                httpContext.RequestAborted, applicationStopping, lifetime.Token);
            var token = linked.Token;

            try
            {
                await response.StartAsync(token);
                await Pump(response, token);
            }
            catch (OperationCanceledException)
            {
                // Fim normal: cliente saiu, aplicação parando ou duração máxima.
            }
            catch (IOException)
            {
                // Conexão derrubada pelo cliente no meio da escrita.
            }
            finally
            {
                subscription.Close();
            }
        }

        private async Task Pump(HttpResponse response, CancellationToken token)
        {
            var reader = subscription.Reader;
            var waiting = reader.WaitToReadAsync(token).AsTask();
            while (true)
            {
                // A mesma espera por dado segue pendente enquanto o keep-alive dispara; o relógio é novo a cada volta.
                using var tick = CancellationTokenSource.CreateLinkedTokenSource(token);
                var delay = Task.Delay(options.KeepAlive, time, tick.Token);
                var finished = await Task.WhenAny(waiting, delay);
                await tick.CancelAsync();

                if (finished == waiting)
                {
                    if (!await waiting)
                    {
                        return;
                    }

                    while (reader.TryRead(out var message))
                    {
                        await WriteEvent(response, message, token);
                    }

                    waiting = reader.WaitToReadAsync(token).AsTask();
                }
                else
                {
                    // Acesso revogado com o fluxo aberto: encerra no próximo ciclo do keep-alive.
                    if (stillAllowed is not null && !await stillAllowed(token))
                    {
                        return;
                    }

                    await response.WriteAsync(": keep-alive\n\n", Utf8, token);
                    await response.Body.FlushAsync(token);
                }
            }
        }

        private static async Task WriteEvent(HttpResponse response, SseMessage<T> message, CancellationToken token)
        {
            // JsonSerializer escreve numa linha só: uma quebra no meio do dado quebraria o quadro SSE.
            var json = JsonSerializer.Serialize(message.Data, JsonSerializerOptions.Web);
            await response.WriteAsync($"event: {message.EventType}\ndata: {json}\n\n", Utf8, token);
            await response.Body.FlushAsync(token);
        }
    }
}
