using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Catalog.GetCatalogCredits;

/// <summary>Uma fonte de catálogo em uso, com o total de exercícios que ela trouxe e a licença dela.</summary>
internal sealed record CreditSource(string Source, int Count, string? License, string? LicenseUrl);

/// <summary>Autor e licença de um grupo de exercícios importados do wger (a atribuição é obrigatória nessa licença).</summary>
internal sealed record WgerCredit(string Author, string License, string? LicenseUrl, int Count);

internal sealed record CatalogCreditsResponse(IReadOnlyList<CreditSource> Sources, IReadOnlyList<WgerCredit> WgerAuthors);

internal sealed class GetCatalogCreditsHandler(TrainingDbContext db, CatalogSeeder seeder)
{
    /// <summary>
    /// Só conta o catálogo vivo (sem lápides e sem exercício próprio): a tela de créditos mostra o que o app realmente usa.
    /// </summary>
    public async Task<CatalogCreditsResponse> HandleAsync(CancellationToken cancellationToken = default)
    {
        await seeder.EnsureSeededAsync(cancellationToken);

        var sources = await db.Exercises.AsNoTracking()
            .Where(e => e.OwnerUserId == null && e.DeletedAt == null)
            .GroupBy(e => new { e.Source, e.License, e.LicenseUrl })
            .Select(g => new { g.Key.Source, g.Key.License, g.Key.LicenseUrl, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var bySource = sources
            .Where(s => s.Source != ExerciseSources.Wger)
            .GroupBy(s => s.Source)
            .Select(g => new CreditSource(g.Key, g.Sum(x => x.Count), g.First().License, g.First().LicenseUrl))
            .OrderBy(s => s.Source, StringComparer.Ordinal)
            .ToList();

        var wger = await db.Exercises.AsNoTracking()
            .Where(e => e.Source == ExerciseSources.Wger && e.DeletedAt == null && e.LicenseAuthor != null)
            .GroupBy(e => new { e.LicenseAuthor, e.License, e.LicenseUrl })
            .Select(g => new { g.Key.LicenseAuthor, g.Key.License, g.Key.LicenseUrl, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var authors = wger
            .Select(w => new WgerCredit(w.LicenseAuthor!, w.License ?? string.Empty, w.LicenseUrl, w.Count))
            .OrderBy(w => w.Author, StringComparer.OrdinalIgnoreCase)
            .ThenBy(w => w.License, StringComparer.Ordinal)
            .ToList();

        var wgerTotal = authors.Sum(a => a.Count);
        if (wgerTotal > 0)
        {
            bySource.Add(new CreditSource(ExerciseSources.Wger, wgerTotal, authors[0].License, authors[0].LicenseUrl));
        }

        return new CatalogCreditsResponse(bySource, authors);
    }
}

internal static class GetCatalogCreditsEndpoint
{
    public static void MapGetCatalogCredits(this IEndpointRouteBuilder group) =>
        group.MapGet("/catalog/credits", async (GetCatalogCreditsHandler handler, CancellationToken cancellationToken) =>
            TypedResults.Ok(await handler.HandleAsync(cancellationToken)))
            .RequireAuthorization(TrainingAuth.Module)
            .Produces<CatalogCreditsResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
}
