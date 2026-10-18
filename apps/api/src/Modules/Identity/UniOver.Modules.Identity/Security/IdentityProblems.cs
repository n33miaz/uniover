using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Identity.Security;

/// <summary>Respostas de erro do módulo como ProblemDetails, com os <c>type</c> estáveis que o cliente reconhece.</summary>
internal static class IdentityProblems
{
    public const string ClientHeader = "X-UniOver-Client";
    public const string ClientHeaderValue = "web";

    public const string LoginLocked = "login-locked";
    public const string RefreshConflict = "refresh-conflict";

    /// <summary>
    /// O cabeçalho obrigatório é uma defesa extra contra CSRF: um formulário de outra origem não consegue
    /// mandar cabeçalho próprio sem passar por CORS (que a API não libera).
    /// </summary>
    public static bool HasClientHeader(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        return request.Headers.TryGetValue(ClientHeader, out StringValues value)
            && string.Equals(value.ToString(), ClientHeaderValue, StringComparison.Ordinal);
    }

    public static IResult MissingClientHeader() =>
        ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
        {
            [ClientHeader] = [$"O cabeçalho {ClientHeader}: {ClientHeaderValue} é obrigatório."],
        });

    public static IResult InvalidCredentials() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "E-mail ou senha inválidos.");

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    public static IResult Locked(HttpResponse response, TimeSpan retryAfter)
    {
        ArgumentNullException.ThrowIfNull(response);
        response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds))
            .ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Results.Problem(
            statusCode: StatusCodes.Status429TooManyRequests,
            title: "Conta temporariamente bloqueada. Tente de novo mais tarde.",
            type: ProblemDetailsExtensions.TypeBase + LoginLocked);
    }

    public static IResult Conflict() =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "A sessão acabou de ser renovada em outra aba. Tente de novo.",
            type: ProblemDetailsExtensions.TypeBase + RefreshConflict);
}
