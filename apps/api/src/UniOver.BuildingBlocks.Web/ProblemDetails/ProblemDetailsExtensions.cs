using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace UniOver.BuildingBlocks.Web;

/// <summary>Erros da API saem como ProblemDetails (RFC 9457), nunca como texto solto.</summary>
public static class ProblemDetailsExtensions
{
    /// <summary>Prefixo dos <c>type</c>: só identificadores estáveis, não precisam resolver.</summary>
    public const string TypeBase = "https://uniover.app/problems/";

    public const string RateLimited = "rate-limited";
    public const string ValidationFailed = "validation-failed";
    public const string PayloadTooLarge = "payload-too-large";

    private static string? CodeFor(int status) => status switch
    {
        StatusCodes.Status400BadRequest => ValidationFailed,
        StatusCodes.Status401Unauthorized => "unauthenticated",
        StatusCodes.Status403Forbidden => "forbidden",
        StatusCodes.Status404NotFound => "not-found",
        StatusCodes.Status405MethodNotAllowed => "method-not-allowed",
        StatusCodes.Status415UnsupportedMediaType => "unsupported-media-type",
        StatusCodes.Status413PayloadTooLarge => PayloadTooLarge,
        StatusCodes.Status429TooManyRequests => RateLimited,
        StatusCodes.Status500InternalServerError => "internal-error",
        _ => null,
    };

    public static IServiceCollection AddUniOverProblemDetails(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddProblemDetails(options => options.CustomizeProblemDetails = context =>
        {
            var problem = context.ProblemDetails;

            // traceId permite ao dono achar a linha de log de uma falha sem expor detalhe interno ao cliente.
            problem.Extensions["traceId"] = System.Diagnostics.Activity.Current?.Id ?? context.HttpContext.TraceIdentifier;

            var code = CodeFor(problem.Status ?? context.HttpContext.Response.StatusCode);
            if (code is not null && (problem.Type is null || !problem.Type.StartsWith(TypeBase, StringComparison.Ordinal)))
            {
                problem.Type = TypeBase + code;
            }
        });
        services.AddExceptionHandler<GlobalExceptionHandler>();
        return services;
    }

    /// <summary>
    /// Exceções viram 500 sem detalhe interno fora de Development; respostas vazias de 4xx/5xx (401, 403, 404,
    /// 405, 415...) ganham corpo <c>application/problem+json</c>.
    /// </summary>
    public static IApplicationBuilder UseUniOverProblemDetails(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.UseExceptionHandler();
        app.UseStatusCodePages();
        return app;
    }

    /// <summary>
    /// Fábrica de erro de validação (400 com <c>errors</c> por campo) que a fatia de cada módulo usa na borda.
    /// </summary>
    public static ProblemHttpResult ValidationProblem(IDictionary<string, string[]> errors)
    {
        ArgumentNullException.ThrowIfNull(errors);

        var problem = new HttpValidationProblemDetails(errors)
        {
            Status = StatusCodes.Status400BadRequest,
            Title = "Um ou mais campos são inválidos.",
            Type = TypeBase + ValidationFailed,
        };
        return TypedResults.Problem(problem);
    }
}
