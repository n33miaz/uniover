using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Catalog;

/// <summary>
/// Carga <b>preguiçosa e versionada</b> do catálogo. Na primeira leitura do catálogo (e do pull), com a tabela vazia ou com
/// <c>seed_version</c> menor que a embutida, grava ou atualiza as linhas <c>free_exercise_db</c> e <c>uniover</c> por
/// (<c>source</c>, <c>source_ref</c>) numa transação. Nunca toca linha <c>own</c> nem <c>wger</c>. Não há leitura de banco na partida: o
/// Neon só acorda quando alguém usa o app, e não por causa do módulo.
/// </summary>
internal sealed class CatalogSeeder(TrainingDbContext db, CatalogSeedSource source, TimeProvider time)
{
    // Chave do trava de aviso do Postgres: duas leituras simultâneas com banco vazio não carregam duas vezes.
    private const long AdvisoryLockKey = 0x7472_6E5F_7365_6564;

    private const int MaxAttempts = 3;

    public async Task EnsureSeededAsync(CancellationToken cancellationToken)
    {
        var seed = source.Document;

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            if (await IsUpToDateAsync(seed.SeedVersion, cancellationToken))
            {
                return;
            }

            try
            {
                await ApplyAsync(seed, cancellationToken);
                return;
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Quem perde a corrida relê: a unicidade garante que só uma carga vence.
                db.ChangeTracker.Clear();
            }
        }
    }

    private async Task<bool> IsUpToDateAsync(int seedVersion, CancellationToken cancellationToken)
    {
        var current = await db.CatalogMeta.AsNoTracking()
            .Where(m => m.Id == CatalogMeta.SingleId)
            .Select(m => (int?)m.SeedVersion)
            .SingleOrDefaultAsync(cancellationToken);
        return current >= seedVersion;
    }

    private async Task ApplyAsync(SeedDocument seed, CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        // Serializa as cargas concorrentes até o fim da transação. Depois de obter a trava, relê a versão: se outra
        // carga terminou enquanto esperávamos, não há mais nada a fazer.
        await db.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({AdvisoryLockKey})", cancellationToken);
        db.ChangeTracker.Clear();
        if (await IsUpToDateAsync(seed.SeedVersion, cancellationToken))
        {
            return;
        }

        var now = TimeStamps.ToStorage(time.GetUtcNow());
        var existing = await db.Exercises
            .Where(e => e.Source == ExerciseSources.FreeExerciseDb || e.Source == ExerciseSources.Uniover)
            .ToDictionaryAsync(e => Key(e.Source, e.SourceRef!), StringComparer.Ordinal, cancellationToken);

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in seed.Exercises)
        {
            seen.Add(Key(item.Source, item.SourceRef));
            if (existing.TryGetValue(Key(item.Source, item.SourceRef), out var row))
            {
                if (Differs(row, item))
                {
                    Copy(item, row);
                    row.UpdatedAt = now;
                    row.ClientUpdatedAt = now;
                }
            }
            else
            {
                var created = new Exercise
                {
                    Id = ExerciseIds.ForCatalog(item.Source, item.SourceRef),
                    Source = item.Source,
                    SourceRef = item.SourceRef,
                    CreatedAt = now,
                    UpdatedAt = now,
                    ClientUpdatedAt = now,
                };
                Copy(item, created);
                db.Exercises.Add(created);
            }
        }

        // Exercício que saiu da semente vira lápide (não é apagado): rotina e histórico antigos ainda o referenciam.
        foreach (var (key, row) in existing)
        {
            if (!seen.Contains(key) && row.DeletedAt is null)
            {
                row.DeletedAt = now;
                row.UpdatedAt = now;
                row.ClientUpdatedAt = now;
            }
        }

        var meta = await db.CatalogMeta.SingleOrDefaultAsync(m => m.Id == CatalogMeta.SingleId, cancellationToken);
        if (meta is null)
        {
            db.CatalogMeta.Add(new CatalogMeta { SeedVersion = seed.SeedVersion, SeededAt = now });
        }
        else
        {
            meta.SeedVersion = seed.SeedVersion;
            meta.SeededAt = now;
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    // A mesma referência pode existir em fontes diferentes: a chave inclui a fonte.
    private static string Key(string source, string sourceRef) => $"{source}:{sourceRef}";

    private static bool Differs(Exercise row, SeedExercise item) =>
        row.DeletedAt is not null
        || row.Slug != item.Slug
        || row.Name != item.Name
        || !row.Instructions.SequenceEqual(item.Instructions, StringComparer.Ordinal)
        || !row.PrimaryMuscles.SequenceEqual(item.PrimaryMuscles, StringComparer.Ordinal)
        || !row.SecondaryMuscles.SequenceEqual(item.SecondaryMuscles, StringComparer.Ordinal)
        || row.Equipment != item.Equipment
        || row.RecordType != item.RecordType
        || row.Level != item.Level
        || row.Category != item.Category
        || row.Mechanic != item.Mechanic;

    private static void Copy(SeedExercise item, Exercise row)
    {
        row.Slug = item.Slug;
        row.Name = item.Name;
        row.Instructions = [.. item.Instructions];
        row.PrimaryMuscles = [.. item.PrimaryMuscles];
        row.SecondaryMuscles = [.. item.SecondaryMuscles];
        row.Equipment = item.Equipment;
        row.RecordType = item.RecordType;
        row.Level = item.Level;
        row.Category = item.Category;
        row.Mechanic = item.Mechanic;
        row.Reviewed = item.Reviewed;
        // O texto reescrito a partir da free-exercise-db herda a licença dela; o que o UniOver escreveu não tem licença de terceiros.
        var fromFreeExerciseDb = item.Source == ExerciseSources.FreeExerciseDb;
        row.License = fromFreeExerciseDb ? "Unlicense" : null;
        row.LicenseUrl = fromFreeExerciseDb ? "https://unlicense.org/" : null;
        row.LicenseAuthor = null;
        row.StepKg = null;
        row.OwnerUserId = null;
        row.DeletedAt = null;
    }
}
