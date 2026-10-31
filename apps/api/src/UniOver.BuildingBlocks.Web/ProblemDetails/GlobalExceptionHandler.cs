using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Último recurso para exceção não tratada: registra no log e devolve 500 genérico. O texto da exceção só
/// aparece em Development, para não vazar caminho, SQL ou stack trace ao cliente.
/// </summary>
internal sealed partial class GlobalExceptionHandler(
    IProblemDetailsService problemDetails,
    IHostEnvironment environment,
    ILogger<GlobalExceptionHandler> logger) : IExceptionHandler
{
    [LoggerMessage(Level = LogLevel.Error, Message = "Exceção não tratada em {Method} {Path}")]
    private static partial void LogUnhandled(ILogger logger, Exception exception, string method, string path);

    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(exception);

        // Corpo malformado ou sem Content-Type é erro do cliente (400/415), não falha do servidor: o Kestrel e o
        // vinculador de parâmetros já trazem o status certo na exceção.
        if (exception is BadHttpRequestException { StatusCode: >= 400 and < 500 } badRequest)
        {
            httpContext.Response.StatusCode = badRequest.StatusCode;
            return await problemDetails.TryWriteAsync(new ProblemDetailsContext
            {
                HttpContext = httpContext,
                ProblemDetails = new Microsoft.AspNetCore.Mvc.ProblemDetails
                {
                    Status = badRequest.StatusCode,
                    Title = badRequest.StatusCode switch
                    {
                        StatusCodes.Status415UnsupportedMediaType => "Tipo de conteúdo não suportado.",
                        StatusCodes.Status413PayloadTooLarge => "O corpo da requisição é grande demais.",
                        _ => "Requisição inválida.",
                    },
                },
            });
        }

        LogUnhandled(logger, exception, httpContext.Request.Method, httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;
        var problem = new Microsoft.AspNetCore.Mvc.ProblemDetails
        {
            Status = StatusCodes.Status500InternalServerError,
            Title = "Erro interno.",
            Detail = environment.IsDevelopment() ? exception.ToString() : null,
        };

        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = problem,
            Exception = exception,
        });
    }
}
