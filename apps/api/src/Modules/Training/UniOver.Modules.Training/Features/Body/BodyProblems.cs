using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Training.Features.Body;

/// <summary>Erros do corpo como ProblemDetails, com os <c>type</c> estáveis que o aparelho reconhece.</summary>
internal static class BodyProblems
{
    public const string EntryNotFoundType = "body-entry-not-found";
    public const string EntryEmptyType = "body-entry-empty";
    public const string ClientClockAheadType = "client-clock-ahead";

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    /// <summary>A medição de outra pessoa é indistinguível de uma que não existe.</summary>
    public static IResult EntryNotFound() =>
        Results.Problem(
            statusCode: StatusCodes.Status404NotFound,
            title: "Medição não encontrada.",
            type: ProblemDetailsExtensions.TypeBase + EntryNotFoundType);

    /// <summary>Medição viva sem nenhum valor: não há o que guardar.</summary>
    public static IResult EntryEmpty() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "A medição precisa de pelo menos um valor (peso, gordura ou uma medida).",
            type: ProblemDetailsExtensions.TypeBase + EntryEmptyType);

    public static IResult ClientClockAhead() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "O relógio do aparelho está mais de 24 horas à frente do servidor.",
            type: ProblemDetailsExtensions.TypeBase + ClientClockAheadType);
}
