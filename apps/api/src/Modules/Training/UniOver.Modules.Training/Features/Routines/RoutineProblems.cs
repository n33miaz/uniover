using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Training.Features.Routines;

/// <summary>Erros das rotinas como ProblemDetails, com os <c>type</c> estáveis que o aparelho reconhece.</summary>
internal static class RoutineProblems
{
    public const string ExerciseNotFoundType = "exercise-not-found";
    public const string SupersetNotContiguousType = "superset-not-contiguous";
    public const string ClientClockAheadType = "client-clock-ahead";

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    /// <summary>A rotina de outra pessoa é indistinguível de uma que não existe.</summary>
    public static IResult NotFound() =>
        Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Rotina não encontrada.");

    public static IResult ExerciseNotFound() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "Algum exercício da rotina não existe.",
            type: ProblemDetailsExtensions.TypeBase + ExerciseNotFoundType);

    public static IResult SupersetNotContiguous() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "Só exercícios vizinhos podem formar uma supersérie.",
            type: ProblemDetailsExtensions.TypeBase + SupersetNotContiguousType);

    public static IResult ClientClockAhead() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "O relógio do aparelho está mais de 24 horas à frente do servidor.",
            type: ProblemDetailsExtensions.TypeBase + ClientClockAheadType);
}
