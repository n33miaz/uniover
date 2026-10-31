using System.Diagnostics;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace UniOver.BuildingBlocks.Web;

/// <summary>Registro de cada requisição (<c>RequestLogging</c>): uma linha por pedido, sem dado do usuário.</summary>
public sealed class RequestLoggingOptions
{
    public const string SectionName = "RequestLogging";

    /// <summary>
    /// Acima disto (ms) o pedido vira aviso. Serve para enxergar partida a frio e banco acordando: com o Render e o Neon
    /// gratuitos dormindo, o primeiro pedido depois de um tempo parado leva segundos, e sem esta linha a lentidão não aparece.
    /// </summary>
    public int SlowMilliseconds { get; set; } = 3000;

    public static bool IsValid(RequestLoggingOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return options.SlowMilliseconds is >= 100 and <= 600_000;
    }
}

public static class RequestLoggingExtensions
{
    /// <summary>Cabeçalho de resposta com o identificador da requisição, o mesmo que aparece no log e no <c>traceId</c> do erro.</summary>
    public const string TraceHeader = "X-Trace-Id";

    public static IServiceCollection AddUniOverRequestLogging(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.AddOptions<RequestLoggingOptions>()
            .Bind(configuration.GetSection(RequestLoggingOptions.SectionName))
            .Validate(RequestLoggingOptions.IsValid, "RequestLogging:SlowMilliseconds fora do permitido (100 a 600000).")
            .ValidateOnStart();
        return services;
    }

    /// <summary>
    /// Uma linha por requisição: método, ROTA (o padrão, como <c>/api/v1/devices/agents/{agentId}/ws</c>, e nunca o caminho
    /// real nem a query string, que podem carregar identificador, código ou segredo), status e duração. Também devolve o
    /// <see cref="TraceHeader"/>, o mesmo <c>TraceId</c> que o formato JSON do log acrescenta a toda linha escrita durante o
    /// pedido: dá para ir de um erro na tela à pilha no log. Sem cabeçalho, corpo, IP nem usuário.
    /// <para>
    /// As sondas de saúde (<c>/health/*</c>) só aparecem em Debug: o monitor externo as chama a cada 5 minutos e a linha de
    /// cada uma afogaria o log. Rota que não existe vira "(sem rota)": varredura de bots não deve escolher o que entra no log.
    /// </para>
    /// </summary>
    public static IApplicationBuilder UseUniOverRequestLogging(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.UseMiddleware<RequestLoggingMiddleware>();
    }
}

internal sealed partial class RequestLoggingMiddleware(
    RequestDelegate next, IOptions<RequestLoggingOptions> options, ILogger<RequestLoggingMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        // OnStarting: o cabeçalho sai junto da resposta, inclusive a de erro montada pelo tratador de exceções.
        context.Response.OnStarting(() =>
        {
            context.Response.Headers[RequestLoggingExtensions.TraceHeader] = TraceIdOf(context);
            return Task.CompletedTask;
        });

        // A rota é lida ANTES de seguir: o tratador de exceções limpa o endpoint ao reexecutar o pedido, e é justamente o erro 500
        // que precisa dizer em qual rota aconteceu.
        var endpoint = context.GetEndpoint() as RouteEndpoint;
        var started = Stopwatch.GetTimestamp();
        try
        {
            await next(context);
        }
        finally
        {
            Write(context, endpoint ?? context.GetEndpoint() as RouteEndpoint, Stopwatch.GetElapsedTime(started));
        }
    }

    private void Write(HttpContext context, RouteEndpoint? endpoint, TimeSpan elapsed)
    {
        var route = endpoint?.RoutePattern.RawText ?? "(sem rota)";
        var method = context.Request.Method;
        var status = context.Response.StatusCode;
        var milliseconds = (long)elapsed.TotalMilliseconds;

        // Sondas de saúde e arquivos estáticos do PWA (sem rota, resposta boa) só em Debug: são o grosso do tráfego e não dizem nada.
        var isProbe = context.Request.Path.StartsWithSegments("/health", StringComparison.OrdinalIgnoreCase);
        // Conexão longa de propósito (o WebSocket do agente, o fluxo SSE da tela) dura horas: não é lentidão.
        var longLived = context.WebSockets.IsWebSocketRequest
            || string.Equals(context.Response.ContentType, "text/event-stream", StringComparison.OrdinalIgnoreCase);
        var level = status >= StatusCodes.Status500InternalServerError || (!longLived && milliseconds >= options.Value.SlowMilliseconds)
            ? LogLevel.Warning
            : isProbe || (endpoint is null && status < 400) ? LogLevel.Debug : LogLevel.Information;

        LogRequest(level, method, route, status, milliseconds);
    }

    /// <summary>O <c>TraceId</c> da atividade da requisição (o do log); sem atividade, o identificador do próprio ASP.NET Core.</summary>
    internal static string TraceIdOf(HttpContext context) =>
        Activity.Current is { TraceId: var id } && id != default
            ? id.ToString()
            : context.TraceIdentifier;

    [LoggerMessage(Message = "HTTP {Method} {Route} respondeu {Status} em {ElapsedMs} ms.")]
    private partial void LogRequest(LogLevel level, string method, string route, int status, long elapsedMs);
}
