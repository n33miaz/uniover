using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Training.Ports;

namespace UniOver.Modules.Training.Features.Catalog.ImportWger;

/// <summary>
/// O funil da importação, na ordem em que os filtros se aplicam. Cada contagem é um subconjunto da anterior; é isto que a
/// simulação (<c>dryRun</c>) devolve para decidir se importar vale a pena.
/// </summary>
/// <param name="DryRun">Simulação: nada foi gravado.</param>
/// <param name="Scanned">Exercícios lidos do wger.</param>
/// <param name="WithPortuguese">Com tradução em português.</param>
/// <param name="WithAuthor">Dos anteriores, com autor da licença preenchido (sem autor a atribuição é impossível).</param>
/// <param name="WithLicense">Dos anteriores, com a licença CC-BY-SA 4.</param>
/// <param name="Unmappable">Dos anteriores, sem nenhum músculo que a taxonomia do app reconheça.</param>
/// <param name="AlreadyImported">Dos restantes, já importados antes (mesmo id do wger).</param>
/// <param name="Duplicates">Dos restantes, com nome igual ao de um exercício do catálogo (comparação sem acento e sem caixa).</param>
/// <param name="Importable">O que sobrou: novo e utilizável.</param>
/// <param name="Imported">Linhas realmente gravadas (zero na simulação).</param>
internal sealed record ImportWgerResponse(
    bool DryRun,
    int Scanned,
    int WithPortuguese,
    int WithAuthor,
    int WithLicense,
    int Unmappable,
    int AlreadyImported,
    int Duplicates,
    int Importable,
    int Imported);

internal enum ImportOutcome
{
    Completed,
    Busy,
    UpstreamUnavailable,
}

internal sealed record ImportWgerResult(ImportOutcome Outcome, ImportWgerResponse Counts);

/// <summary>Garante uma importação por vez no processo (o wger é de terceiros e o app o trata com cerimônia).</summary>
internal sealed class WgerImportGate : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public bool TryEnter() => _gate.Wait(0);

    public void Exit() => _gate.Release();

    public void Dispose() => _gate.Dispose();
}

internal sealed partial class ImportWgerHandler(
    TrainingDbContext db,
    CatalogSeeder seeder,
    IWgerClient wger,
    WgerImportGate gate,
    IOptions<TrainingModuleOptions> options,
    TimeProvider time,
    ILogger<ImportWgerHandler> logger)
{
    public async Task<ImportWgerResult> HandleAsync(bool dryRun, CancellationToken cancellationToken = default)
    {
        if (!gate.TryEnter())
        {
            return new ImportWgerResult(ImportOutcome.Busy, new ImportWgerResponse(dryRun, 0, 0, 0, 0, 0, 0, 0, 0, 0));
        }

        try
        {
            return await RunAsync(dryRun, cancellationToken);
        }
        finally
        {
            gate.Exit();
        }
    }

    private async Task<ImportWgerResult> RunAsync(bool dryRun, CancellationToken cancellationToken)
    {
        var settings = options.Value.Import.Wger;

        // O catálogo precisa estar carregado antes da comparação de nomes.
        await seeder.EnsureSeededAsync(cancellationToken);

        var catalogRows = await db.Exercises.AsNoTracking()
            .Where(e => e.OwnerUserId == null)
            .Select(e => new { e.Name, e.Source, e.SourceRef })
            .ToListAsync(cancellationToken);
        var names = new HashSet<string>(catalogRows.Select(r => TextNormalizer.Fold(r.Name)), StringComparer.Ordinal);
        var imported = new HashSet<string>(
            catalogRows.Where(r => r.Source == ExerciseSources.Wger && r.SourceRef is not null).Select(r => r.SourceRef!),
            StringComparer.Ordinal);

        int scanned = 0, withPt = 0, withAuthor = 0, withLicense = 0, unmappable = 0, already = 0, duplicates = 0, importable = 0, written = 0;
        ImportWgerResponse Snapshot() =>
            new(dryRun, scanned, withPt, withAuthor, withLicense, unmappable, already, duplicates, importable, written);

        var offset = 0;
        try
        {
            while (scanned < settings.MaxItems)
            {
                var page = await wger.GetExercisesAsync(offset, settings.PageSize, cancellationToken);
                var pending = new List<Exercise>();

                foreach (var item in page.Items)
                {
                    if (scanned >= settings.MaxItems)
                    {
                        break;
                    }

                    scanned++;
                    var portuguese = item.Translations.Where(t => t.LanguageId == settings.LanguageId).ToList();
                    if (portuguese.Count == 0)
                    {
                        continue;
                    }

                    withPt++;
                    var authored = portuguese.Where(t => !string.IsNullOrWhiteSpace(t.LicenseAuthor)).ToList();
                    if (authored.Count == 0)
                    {
                        continue;
                    }

                    withAuthor++;
                    if (authored.FirstOrDefault(t => t.LicenseId == WgerMapping.LicenseIdCcBySa4) is not { } translation)
                    {
                        continue;
                    }

                    withLicense++;
                    var primary = WgerMapping.MapMuscles(item.MuscleIds).Take(Exercise.MusclesMax).ToList();
                    if (primary.Count == 0)
                    {
                        unmappable++;
                        continue;
                    }

                    if (imported.Contains(item.Uuid))
                    {
                        already++;
                        continue;
                    }

                    var name = Truncate(translation.Name.Trim(), Exercise.NameMax);
                    if (!names.Add(TextNormalizer.Fold(name)))
                    {
                        duplicates++;
                        continue;
                    }

                    importable++;
                    if (!dryRun)
                    {
                        pending.Add(ToRow(item, translation, name, primary));
                    }
                }

                if (pending.Count > 0)
                {
                    // Uma transação por página: se o wger falhar adiante, o que já entrou fica e é relatado.
                    db.Exercises.AddRange(pending);
                    await db.SaveChangesAsync(cancellationToken);
                    written += pending.Count;
                    db.ChangeTracker.Clear();
                }

                offset += settings.PageSize;
                if (!page.HasNext)
                {
                    break;
                }
            }
        }
        catch (WgerUnavailableException ex)
        {
            LogInterrupted(logger, ex, scanned, written);
            return new ImportWgerResult(ImportOutcome.UpstreamUnavailable, Snapshot());
        }

        return new ImportWgerResult(ImportOutcome.Completed, Snapshot());
    }

    private Exercise ToRow(WgerExercise item, WgerTranslation translation, string name, List<string> primary)
    {
        var now = TimeStamps.ToStorage(time.GetUtcNow());
        var id = ExerciseIds.ForCatalog(ExerciseSources.Wger, item.Uuid);
        var secondary = WgerMapping.MapSecondary(item.SecondaryMuscleIds, primary);
        var equipment = WgerMapping.MapEquipment(item.EquipmentIds);
        return new Exercise
        {
            Id = id,
            Slug = TextNormalizer.SlugWithId(name, id),
            Source = ExerciseSources.Wger,
            SourceRef = item.Uuid,
            Name = name,
            Instructions = WgerMapping.ToInstructions(translation.DescriptionHtml),
            PrimaryMuscles = primary,
            SecondaryMuscles = secondary,
            Equipment = equipment,
            RecordType = equipment == Equipment.Bodyweight ? ExerciseRecordTypes.RepsOnly : ExerciseRecordTypes.WeightReps,
            License = WgerMapping.LicenseName,
            LicenseUrl = WgerMapping.LicenseUrl,
            LicenseAuthor = Truncate(translation.LicenseAuthor!.Trim(), 200),
            Reviewed = false,
            CreatedAt = now,
            UpdatedAt = now,
            ClientUpdatedAt = now,
        };
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Importação do wger interrompida depois de {Scanned} exercícios lidos e {Imported} gravados.")]
    private static partial void LogInterrupted(ILogger logger, Exception exception, int scanned, int imported);

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max].TrimEnd();
}
