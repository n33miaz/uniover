using System.Diagnostics;
using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Domain.Sessions;

namespace UniOver.IntegrationTests.Training;

[Collection(PostgresGroup.Name)]
public sealed class CatalogSeedingTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static SeedExercise Item(string sourceRef, string name, string instruction = "Faça o movimento.", string equipment = Equipment.Barbell) =>
        new(sourceRef, TextNormalizer.Slugify(name), name, [instruction], [Muscle.Chest], [Muscle.Triceps], equipment,
            ExerciseRecordTypes.WeightReps, "beginner", "strength", "compound", false, "abc");

    private static SeedDocument Document(int version, params SeedExercise[] items) => new(version, "abc", items);

    private static CatalogSeeder SeederFor(TrainingApp app, SeedDocument document, TimeProvider? time = null) =>
        new(app.Db(), new CatalogSeedSource(document), time ?? TimeProvider.System);

    [Fact]
    public async Task Startup_NeverTouchesTheTrainingModuleInTheDatabase()
    {
        // O schema training nem existe: se a partida (ou o login) consultasse o módulo, falharia.
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { MigrateTraining = false, CaptureSql = true });

        await app.LoginAsync();

        app.Logs.Lines.Should().NotContain(line => line.Contains("\"training\"", StringComparison.Ordinal)
            || line.Contains("training.", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Startup_WithTheSchemaMigrated_LeavesTheCatalogEmptyUntilTheFirstRead()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { CaptureSql = true });
        await app.LoginAsync();

        await using (var db = app.Db())
        {
            (await db.Exercises.CountAsync(Ct)).Should().Be(0);
            (await db.CatalogMeta.CountAsync(Ct)).Should().Be(0);
        }

        app.Logs.Lines.Should().NotContain(line => line.Contains("\"training\".\"exercises\"", StringComparison.Ordinal),
            "nenhuma consulta ao catálogo antes da primeira leitura");
    }

    [Fact]
    public async Task ProductionHost_StartsAndServesLiveness_WithAnUnreachableDatabase()
    {
        // Prova a regra do Neon: com o banco fora do ar, a partida não pode consultar nada (nem a semente).
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = "Host=banco-inexistente.invalid;Database=d;Username=u;Password=p;Timeout=15",
        };
        await using var factory = new EdgeFactory("Production", settings);
        using var client = factory.CreateClient();

        var clock = Stopwatch.StartNew();
        var response = await client.GetAsync("/health/live", Ct);
        clock.Stop();

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        clock.Elapsed.Should().BeLessThan(TimeSpan.FromSeconds(3));
    }

    [Fact]
    public async Task FirstRead_LoadsTheEmbeddedSeed_OnceOnly()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var expected = CatalogSeedSource.Read();

        using (var first = await app.PullAsync(login, limit: 1))
        {
            first.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await using var db = app.Db();
        (await db.Exercises.CountAsync(Ct)).Should().Be(expected.Exercises.Count);
        var meta = await db.CatalogMeta.SingleAsync(Ct);
        meta.SeedVersion.Should().Be(expected.SeedVersion);

        using (var second = await app.PullAsync(login, limit: 1))
        {
            second.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await using var again = app.Db();
        (await again.CatalogMeta.SingleAsync(Ct)).SeededAt.Should().Be(meta.SeededAt, "a segunda leitura não recarrega a semente");
        (await again.Exercises.CountAsync(Ct)).Should().Be(expected.Exercises.Count);
    }

    [Fact]
    public async Task SeededRows_UseDeterministicIdsAndTheUnlicenseData()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using (await app.PullAsync(login, limit: 1))
        {
        }

        var sample = CatalogSeedSource.Read().Exercises[0];
        await using var db = app.Db();
        var row = await db.Exercises.SingleAsync(e => e.Source == ExerciseSources.FreeExerciseDb && e.SourceRef == sample.SourceRef, Ct);

        row.Id.Should().Be(ExerciseIds.ForCatalog(ExerciseSources.FreeExerciseDb, sample.SourceRef));
        row.Name.Should().Be(sample.Name);
        row.License.Should().Be("Unlicense");
        row.OwnerUserId.Should().BeNull();
        row.Reviewed.Should().BeFalse();
    }

    [Fact]
    public async Task EmptyDatabase_GetsAllRows_AndTheMetaRow()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var document = Document(1, Item("a", "Supino A"), Item("b", "Supino B"));

        await SeederFor(app, document).EnsureSeededAsync(Ct);

        await using var db = app.Db();
        (await db.Exercises.Select(e => e.SourceRef).OrderBy(r => r).ToListAsync(Ct)).Should().Equal("a", "b");
        (await db.CatalogMeta.SingleAsync(Ct)).SeedVersion.Should().Be(1);
    }

    [Fact]
    public async Task RowsOfTheUniOverSource_AreSeededNextToTheOthers_WithTheirOwnIdsAndNoThirdPartyLicense()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var own = Item("goblet", "Agachamento Goblet", equipment: Equipment.Kettlebell) with { Source = ExerciseSources.Uniover };
        // A mesma referência em duas fontes não colide: a chave inclui a fonte.
        var document = Document(2, Item("goblet", "Supino A"), own);

        await SeederFor(app, document).EnsureSeededAsync(Ct);

        await using var db = app.Db();
        var row = await db.Exercises.SingleAsync(e => e.Source == ExerciseSources.Uniover, Ct);
        row.SourceRef.Should().Be("goblet");
        row.Equipment.Should().Be(Equipment.Kettlebell);
        row.Id.Should().Be(ExerciseIds.ForCatalog(ExerciseSources.Uniover, "goblet"));
        row.License.Should().BeNull();
        row.LicenseUrl.Should().BeNull();
        row.IsCatalog.Should().BeTrue();
        (await db.Exercises.CountAsync(Ct)).Should().Be(2);

        // O que sai da semente vira lápide, também nesta fonte.
        await SeederFor(app, Document(3, Item("goblet", "Supino A"))).EnsureSeededAsync(Ct);
        await using var check = app.Db();
        (await check.Exercises.SingleAsync(e => e.Source == ExerciseSources.Uniover, Ct)).DeletedAt.Should().NotBeNull();
    }

    [Fact]
    public async Task SeedVersionTwo_PreservesExistingReferencesAndLoadChoices_AndAddsEachNewExerciseOnce()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var versionTwo = CatalogSeedSource.Read();
        var newExercises = versionTwo.Exercises.Where(e => e.Source == ExerciseSources.Uniover).ToArray();
        var versionOne = new SeedDocument(1, versionTwo.SourceCommit,
            versionTwo.Exercises.Where(e => e.Source != ExerciseSources.Uniover).ToArray());
        var oldExercise = versionOne.Exercises[0];
        var oldExerciseId = ExerciseIds.ForCatalog(oldExercise.Source, oldExercise.SourceRef);
        var userId = Guid.NewGuid();
        var routineId = Guid.CreateVersion7();
        var sessionId = Guid.CreateVersion7();
        var setId = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        var expectedLegacyExercises = versionOne.Exercises
            .Select(e => (e.Source, (string?)e.SourceRef, Id: ExerciseIds.ForCatalog(e.Source, e.SourceRef)))
            .OrderBy(e => e.Id)
            .ToArray();
        var expectedUniOverExercises = newExercises
            .Select(e => ((string?)e.SourceRef, Id: ExerciseIds.ForCatalog(e.Source, e.SourceRef)))
            .OrderBy(e => e.Id)
            .ToArray();

        newExercises.Should().NotBeEmpty();
        await SeederFor(app, versionOne).EnsureSeededAsync(Ct);

        await using (var db = app.Db())
        {
            db.Set<Routine>().Add(new Routine
            {
                Id = routineId,
                UserId = userId,
                Name = "Rotina preservada",
                Position = 0,
                CreatedAt = now,
                UpdatedAt = now,
                ClientUpdatedAt = now,
                Items =
                [
                    new RoutineItem
                    {
                        Id = Guid.CreateVersion7(),
                        ExerciseId = oldExerciseId,
                        Position = 0,
                        TargetSets = 3,
                        RepMin = 8,
                        RepMax = 12,
                        RestSeconds = 90,
                    },
                ],
            });
            db.Set<Session>().Add(new Session
            {
                Id = sessionId,
                UserId = userId,
                RoutineId = routineId,
                StartedAt = now,
                FinishedAt = now.AddMinutes(30),
                DeviceId = "aparelho",
                CreatedAt = now,
                UpdatedAt = now,
                ClientUpdatedAt = now,
            });
            db.Set<SessionSet>().Add(new SessionSet
            {
                Id = setId,
                UserId = userId,
                SessionId = sessionId,
                ExerciseId = oldExerciseId,
                Position = 0,
                SetType = SetTypes.Work,
                WeightKg = 42.5m,
                Reps = 10,
                CompletedAt = now.AddMinutes(10),
                CreatedAt = now,
                UpdatedAt = now,
                ClientUpdatedAt = now,
            });
            db.ExerciseOverrides.Add(new ExerciseOverride
            {
                UserId = userId,
                ExerciseId = oldExerciseId,
                StepKg = 1.25m,
                UpdatedAt = now,
                ClientUpdatedAt = now,
            });
            await db.SaveChangesAsync(Ct);
        }

        await SeederFor(app, versionTwo).EnsureSeededAsync(Ct);
        DateTimeOffset seededAt;
        Dictionary<Guid, DateTimeOffset> updatedAt;
        await using (var afterFirstUpdate = app.Db())
        {
            seededAt = (await afterFirstUpdate.CatalogMeta.SingleAsync(Ct)).SeededAt;
            updatedAt = await afterFirstUpdate.Exercises
                .Select(e => new { e.Id, e.UpdatedAt })
                .ToDictionaryAsync(e => e.Id, e => e.UpdatedAt, Ct);
        }

        await SeederFor(app, versionTwo).EnsureSeededAsync(Ct);

        await using var check = app.Db();
        var meta = await check.CatalogMeta.SingleAsync(Ct);
        meta.SeedVersion.Should().Be(versionTwo.SeedVersion);
        meta.SeededAt.Should().Be(seededAt, "a segunda carga não pode regravar os metadados");
        (await check.Exercises.SingleAsync(e => e.Id == oldExerciseId, Ct)).SourceRef.Should().Be(oldExercise.SourceRef);
        (await check.Set<RoutineItem>().SingleAsync(i => i.RoutineId == routineId, Ct)).ExerciseId.Should().Be(oldExerciseId);
        (await check.Set<Session>().SingleAsync(s => s.Id == sessionId, Ct)).RoutineId.Should().Be(routineId);
        var storedSet = await check.Set<SessionSet>().SingleAsync(s => s.Id == setId, Ct);
        storedSet.ExerciseId.Should().Be(oldExerciseId);
        storedSet.WeightKg.Should().Be(42.5m);
        (await check.ExerciseOverrides.SingleAsync(o => o.UserId == userId && o.ExerciseId == oldExerciseId, Ct)).StepKg.Should().Be(1.25m);
        (await check.Exercises.CountAsync(Ct)).Should().Be(versionTwo.Exercises.Count);
        (await check.Exercises
            .Select(e => new { e.Source, e.SourceRef, e.Id, e.UpdatedAt })
            .ToDictionaryAsync(e => e.Id, e => e.UpdatedAt, Ct)).Should().BeEquivalentTo(updatedAt);

        var legacyExercises = (await check.Exercises
                .Where(e => e.Source != ExerciseSources.Uniover)
                .Select(e => new { e.Source, e.SourceRef, e.Id })
                .ToListAsync(Ct))
            .Select(e => (e.Source, e.SourceRef, e.Id))
            .OrderBy(e => e.Id)
            .ToArray();
        legacyExercises.Should().Equal(expectedLegacyExercises);

        var uniOverExercises = (await check.Exercises
                .Where(e => e.Source == ExerciseSources.Uniover)
                .Select(e => new { e.SourceRef, e.Id })
                .ToListAsync(Ct))
            .Select(e => (e.SourceRef, e.Id))
            .OrderBy(e => e.Id)
            .ToArray();
        uniOverExercises.Should().Equal(expectedUniOverExercises);
    }

    [Fact]
    public async Task CatalogSourceMigration_RollbackIsAlwaysRefused()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        await SeederFor(app, CatalogSeedSource.Read()).EnsureSeededAsync(Ct);

        await using var db = app.Db();
        var migrator = db.GetService<IMigrator>();
        Func<Task> rollback = () => migrator.MigrateAsync("20261028024002_AddCalendarEntries", Ct);

        var exception = await rollback.Should().ThrowAsync<PostgresException>();
        exception.Which.MessageText.Should().Contain("irreversível");
    }

    [Fact]
    public async Task NewerSeedVersion_CorrectsTheText_AndNeverTouchesOwnOrWgerRows()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        await SeederFor(app, Document(1, Item("a", "Supino A", "Texto com erro."), Item("b", "Supino B"))).EnsureSeededAsync(Ct);

        var own = Guid.CreateVersion7();
        var wger = ExerciseIds.ForCatalog(ExerciseSources.Wger, "uuid-1");
        var user = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        await using (var db = app.Db())
        {
            db.Exercises.Add(new Exercise
            {
                Id = own, Slug = "meu-x", Source = ExerciseSources.Own, Name = "Meu X", OwnerUserId = user, Equipment = Equipment.Other,
                PrimaryMuscles = [Muscle.Chest], CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            });
            db.Exercises.Add(new Exercise
            {
                Id = wger, Slug = "w-1", Source = ExerciseSources.Wger, SourceRef = "uuid-1", Name = "Wger 1", Equipment = Equipment.Other,
                PrimaryMuscles = [Muscle.Chest], License = "CC-BY-SA 4", LicenseAuthor = "Ana", CreatedAt = now, UpdatedAt = now, ClientUpdatedAt = now,
            });
            await db.SaveChangesAsync(Ct);
        }

        // Versão 2: o texto de "a" foi corrigido, "b" saiu da semente e "c" entrou.
        await SeederFor(app, Document(2, Item("a", "Supino A", "Texto corrigido."), Item("c", "Supino C"))).EnsureSeededAsync(Ct);

        await using var check = app.Db();
        var a = await check.Exercises.SingleAsync(e => e.SourceRef == "a" && e.Source == ExerciseSources.FreeExerciseDb, Ct);
        a.Instructions.Should().Equal("Texto corrigido.");
        a.DeletedAt.Should().BeNull();

        var b = await check.Exercises.SingleAsync(e => e.SourceRef == "b" && e.Source == ExerciseSources.FreeExerciseDb, Ct);
        b.DeletedAt.Should().NotBeNull("o que sai da semente vira lápide: rotina e histórico antigos ainda o referenciam");

        (await check.Exercises.AnyAsync(e => e.SourceRef == "c" && e.Source == ExerciseSources.FreeExerciseDb, Ct)).Should().BeTrue();
        (await check.Exercises.SingleAsync(e => e.Id == own, Ct)).Name.Should().Be("Meu X");
        (await check.Exercises.SingleAsync(e => e.Id == wger, Ct)).DeletedAt.Should().BeNull();
        (await check.CatalogMeta.SingleAsync(Ct)).SeedVersion.Should().Be(2);
    }

    [Fact]
    public async Task SameSeedVersion_DoesNotRewriteAnything()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var document = Document(1, Item("a", "Supino A"));
        await SeederFor(app, document).EnsureSeededAsync(Ct);
        DateTimeOffset before;
        await using (var db = app.Db())
        {
            before = (await db.Exercises.SingleAsync(Ct)).UpdatedAt;
        }

        await SeederFor(app, Document(1, Item("a", "Supino A", "Texto novo, mas versão igual."))).EnsureSeededAsync(Ct);

        await using var check = app.Db();
        var row = await check.Exercises.SingleAsync(Ct);
        row.UpdatedAt.Should().Be(before);
        row.Instructions.Should().Equal("Faça o movimento.");
    }

    [Fact]
    public async Task TwoSimultaneousFirstReads_LoadTheSeedOnce_WithoutError()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var items = Enumerable.Range(0, 60).Select(i => Item($"ref-{i}", $"Exercício {i}")).ToArray();
        var document = Document(1, items);

        var tasks = Enumerable.Range(0, 6).Select(_ => Task.Run(() => SeederFor(app, document).EnsureSeededAsync(Ct), Ct)).ToArray();
        await Task.WhenAll(tasks);

        await using var db = app.Db();
        (await db.Exercises.CountAsync(Ct)).Should().Be(60);
        (await db.CatalogMeta.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task SimultaneousFirstHttpReads_AllSucceed_AndLoadTheSeedOnce()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => app.PullAsync(login, limit: 5)));

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.CatalogMeta.CountAsync(Ct)).Should().Be(1);
        (await db.Exercises.CountAsync(Ct)).Should().Be(CatalogSeedSource.Read().Exercises.Count);
    }
}
