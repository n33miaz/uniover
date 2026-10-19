using System.Globalization;
using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Devices.Security;

/// <summary>Respostas de erro do pareamento como ProblemDetails, com os <c>type</c> estáveis que o agente reconhece.</summary>
internal static class PairingProblems
{
    public const string ExpiredType = "pairing-expired";
    public const string ConsumedType = "pairing-consumed";
    public const string DeniedType = "pairing-denied";
    public const string NotFoundType = "pairing-not-found";
    public const string TooManyType = "too-many-pairings";

    /// <summary>
    /// Pareamento ou código desconhecido: a mesma resposta para id inexistente e <c>deviceCode</c> errado, e para
    /// código de usuário inexistente, vencido ou já decidido; quem tenta não aprende qual dos casos aconteceu.
    /// </summary>
    public static IResult NotFound() =>
        Results.Problem(
            statusCode: StatusCodes.Status404NotFound,
            title: "Pareamento não encontrado.",
            type: ProblemDetailsExtensions.TypeBase + NotFoundType);

    public static IResult Expired() =>
        Results.Problem(
            statusCode: StatusCodes.Status410Gone,
            title: "O código de pareamento venceu. Peça um novo.",
            type: ProblemDetailsExtensions.TypeBase + ExpiredType);

    public static IResult Consumed() =>
        Results.Problem(
            statusCode: StatusCodes.Status410Gone,
            title: "O token deste pareamento já foi entregue.",
            type: ProblemDetailsExtensions.TypeBase + ConsumedType);

    public static IResult Denied() =>
        Results.Problem(
            statusCode: StatusCodes.Status403Forbidden,
            title: "O pareamento foi recusado.",
            type: ProblemDetailsExtensions.TypeBase + DeniedType);

    public static IResult TooManyActive(HttpResponse response, TimeSpan retryAfter)
    {
        ArgumentNullException.ThrowIfNull(response);
        response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds))
            .ToString(CultureInfo.InvariantCulture);
        return Results.Problem(
            statusCode: StatusCodes.Status429TooManyRequests,
            title: "Há pareamentos demais em aberto. Tente de novo mais tarde.",
            type: ProblemDetailsExtensions.TypeBase + TooManyType);
    }

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");
}
