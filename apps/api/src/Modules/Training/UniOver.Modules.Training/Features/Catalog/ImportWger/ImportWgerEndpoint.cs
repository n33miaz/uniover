using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Training.Features.Catalog.ImportWger;

internal static class ImportWgerEndpoint
{
    // dryRun começa ligado de propósito: importar de verdade é sempre uma escolha explícita (dryRun=false).
    // Só o administrador: a importação grava o catálogo COMPARTILHADO (todos os usuários o enxergam) e gasta a cota do
    // wger, então quem tem apenas a permissão do Treino nunca chega aqui.
    public static void MapImportWger(this IEndpointRouteBuilder group) =>
        group.MapPost("/catalog/imports/wger", HandleAsync)
            .RequireAuthorization(TrainingAuth.AdminOnly)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<ImportWgerResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        ImportWgerHandler handler,
        bool? dryRun,
        CancellationToken cancellationToken)
    {
        if (!current.IsAuthenticated)
        {
            return CatalogProblems.Unauthenticated();
        }

        var result = await handler.HandleAsync(dryRun ?? true, cancellationToken);
        return result.Outcome switch
        {
            ImportOutcome.Completed => TypedResults.Ok(result.Counts),
            ImportOutcome.Busy => CatalogProblems.ImportInProgress(),
            _ => CatalogProblems.UpstreamUnavailable(result.Counts.Scanned, result.Counts.Imported),
        };
    }
}
