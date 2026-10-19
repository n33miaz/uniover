using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Catalog.PullExercises;

internal sealed record PullExercisesQuery(Guid UserId, PullCursor? After, int Limit);

internal sealed record PullExercisesResponse(IReadOnlyList<ExerciseResponse> Items, string? NextCursor);

internal sealed class PullExercisesHandler(TrainingDbContext db, CatalogSeeder seeder)
{
    /// <summary>
    /// Catálogo e exercícios próprios do usuário, em páginas ordenadas por (instante, id), lápides incluídas. O instante
    /// de ordenação é o mais novo entre a linha do exercício e a escolha de salto do usuário: mudar o salto de um
    /// exercício de catálogo também precisa chegar aos outros aparelhos.
    /// </summary>
    public async Task<PullExercisesResponse> HandleAsync(PullExercisesQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        // Primeira leitura do catálogo: carrega a semente (preguiçosa e versionada).
        await seeder.EnsureSeededAsync(cancellationToken);

        var userId = query.UserId;
        var rows =
            from e in db.Exercises.AsNoTracking()
            where e.OwnerUserId == null || e.OwnerUserId == userId
            join o in db.ExerciseOverrides.AsNoTracking().Where(o => o.UserId == userId)
                on e.Id equals o.ExerciseId into choices
            from o in choices.DefaultIfEmpty()
            select new { Exercise = e, Choice = o, Stamp = o != null && o.UpdatedAt > e.UpdatedAt ? o.UpdatedAt : e.UpdatedAt };

        if (query.After is { } after)
        {
            var stamp = after.UpdatedAt;
            var id = after.Id;
            rows = rows.Where(r => r.Stamp > stamp || (r.Stamp == stamp && r.Exercise.Id.CompareTo(id) > 0));
        }

        var page = await rows
            .OrderBy(r => r.Stamp)
            .ThenBy(r => r.Exercise.Id)
            .Take(query.Limit)
            .ToListAsync(cancellationToken);

        var items = page.Select(r => ExerciseResponse.From(r.Exercise, r.Choice)).ToList();
        var next = page.Count > 0
            ? new PullCursor(page[^1].Stamp, page[^1].Exercise.Id).Encode()
            : query.After?.Encode();
        return new PullExercisesResponse(items, next);
    }
}
