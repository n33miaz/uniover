using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Training.Features.Goals;

/// <summary>Erros das metas como ProblemDetails, com os <c>type</c> estáveis que o aparelho reconhece.</summary>
internal static class GoalProblems
{
    public const string ExerciseNotFoundType = "exercise-not-found";
    public const string ClientClockAheadType = "client-clock-ahead";

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    /// <summary>O exercício de outra pessoa é indistinguível de um que não existe.</summary>
    public static IResult ExerciseNotFound() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "O exercício da meta não existe.",
            type: ProblemDetailsExtensions.TypeBase + ExerciseNotFoundType);

    public static IResult ClientClockAhead() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "O relógio do aparelho está mais de 24 horas à frente do servidor.",
            type: ProblemDetailsExtensions.TypeBase + ClientClockAheadType);
}
