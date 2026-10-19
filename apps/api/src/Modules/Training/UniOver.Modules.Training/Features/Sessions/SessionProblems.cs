using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Training.Features.Sessions;

/// <summary>Erros das sessões e séries como ProblemDetails, com os <c>type</c> estáveis que o aparelho reconhece.</summary>
internal static class SessionProblems
{
    public const string SessionNotFoundType = "session-not-found";
    public const string RoutineNotFoundType = "routine-not-found";
    public const string ExerciseNotFoundType = "exercise-not-found";
    public const string SetShapeInvalidType = "set-shape-invalid";
    public const string FinishBeforeStartType = "session-finish-before-start";
    public const string SessionAlreadyOpenType = "session-already-open";
    public const string ClientClockAheadType = "client-clock-ahead";

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    /// <summary>A sessão de outra pessoa é indistinguível de uma que não existe.</summary>
    public static IResult SessionNotFound() =>
        Results.Problem(
            statusCode: StatusCodes.Status404NotFound,
            title: "Treino não encontrado.",
            type: ProblemDetailsExtensions.TypeBase + SessionNotFoundType);

    public static IResult RoutineNotFound() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "A rotina do treino não existe.",
            type: ProblemDetailsExtensions.TypeBase + RoutineNotFoundType);

    public static IResult ExerciseNotFound() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "O exercício da série não existe.",
            type: ProblemDetailsExtensions.TypeBase + ExerciseNotFoundType);

    public static IResult SetShapeInvalid() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "A série não tem os campos que o tipo de registro do exercício exige.",
            type: ProblemDetailsExtensions.TypeBase + SetShapeInvalidType);

    public static IResult FinishBeforeStart() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "O treino não pode terminar antes de começar.",
            type: ProblemDetailsExtensions.TypeBase + FinishBeforeStartType);

    public static IResult ClientClockAhead() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "O relógio do aparelho está mais de 24 horas à frente do servidor.",
            type: ProblemDetailsExtensions.TypeBase + ClientClockAheadType);

    /// <summary>
    /// Um aparelho por vez: já existe um treino em andamento (neste ou em outro aparelho). A resposta diz qual e onde, para
    /// o aparelho dono poder encerrá-lo.
    /// </summary>
    public static IResult SessionAlreadyOpen(Guid sessionId, string deviceId, DateTimeOffset startedAt) =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "Já existe um treino em andamento em outro aparelho. Encerre-o antes de começar outro.",
            type: ProblemDetailsExtensions.TypeBase + SessionAlreadyOpenType,
            extensions: new Dictionary<string, object?>
            {
                ["sessionId"] = sessionId,
                ["deviceId"] = deviceId,
                ["startedAt"] = startedAt,
            });
}
