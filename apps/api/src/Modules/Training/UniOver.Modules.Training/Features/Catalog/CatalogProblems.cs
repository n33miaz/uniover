using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Training.Features.Catalog;

/// <summary>Erros do catálogo como ProblemDetails, com os <c>type</c> estáveis que o aparelho reconhece.</summary>
internal static class CatalogProblems
{
    public const string CatalogRowReadonlyType = "catalog-row-readonly";
    public const string ClientClockAheadType = "client-clock-ahead";
    public const string UpstreamUnavailableType = "upstream-unavailable";
    public const string ImportInProgressType = "import-in-progress";

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    public static IResult NotFound() =>
        Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Exercício não encontrado.");

    /// <summary>Exercício de catálogo não se edita: quem quer mudar o texto faz uma cópia própria.</summary>
    public static IResult CatalogRowReadonly() =>
        Results.Problem(
            statusCode: StatusCodes.Status403Forbidden,
            title: "Exercício do catálogo não pode ser editado; crie uma cópia própria.",
            type: ProblemDetailsExtensions.TypeBase + CatalogRowReadonlyType);

    public static IResult ClientClockAhead() =>
        Results.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "O relógio do aparelho está mais de 24 horas à frente do servidor.",
            type: ProblemDetailsExtensions.TypeBase + ClientClockAheadType);

    public static IResult ImportInProgress() =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "Já existe uma importação em andamento.",
            type: ProblemDetailsExtensions.TypeBase + ImportInProgressType);

    /// <summary>O wger falhou; o que já tinha entrado fica (e é relatado), nada é descartado em silêncio.</summary>
    public static IResult UpstreamUnavailable(int scanned, int imported) =>
        Results.Problem(
            statusCode: StatusCodes.Status502BadGateway,
            title: "O wger não respondeu. A importação parou; o que já entrou foi mantido.",
            type: ProblemDetailsExtensions.TypeBase + UpstreamUnavailableType,
            extensions: new Dictionary<string, object?>
            {
                ["scanned"] = scanned,
                ["imported"] = imported,
            });
}
