using System.Text.Json;
using System.Text.RegularExpressions;
using AwesomeAssertions;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Tests.Catalog;

/// <summary>
/// Conteúdo da semente embutida: o esquema, o vocabulário fechado, a consistência do glossário e a prova de que o texto
/// em português é reescrito (nunca igual ao original em inglês).
/// </summary>
public partial class SeedContentTests
{
    private static readonly SeedDocument Seed = CatalogSeedSource.Read();

    private static readonly Lazy<Dictionary<string, OriginalExercise>> Originals = new(LoadOriginals);

    private sealed record OriginalExercise(string Id, string Name, string[] Instructions);

    private static Dictionary<string, OriginalExercise> LoadOriginals()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "assets-third-party", "free-exercise-db", "exercises.json")))
        {
            dir = dir.Parent;
        }

        dir.Should().NotBeNull("o texto original fica em assets-third-party/free-exercise-db");
        using var stream = File.OpenRead(Path.Combine(dir!.FullName, "assets-third-party", "free-exercise-db", "exercises.json"));
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.EnumerateArray()
            .Select(e => new OriginalExercise(
                e.GetProperty("id").GetString()!,
                e.GetProperty("name").GetString()!,
                [.. e.GetProperty("instructions").EnumerateArray().Select(i => i.GetString()!)]))
            .ToDictionary(o => o.Id, StringComparer.Ordinal);
    }

    // Palavras em inglês que denunciam texto não traduzido (estrangeirismos aceitos de academia não estão aqui).
    [GeneratedRegex(@"\b(the|with|your|and|you|then|until|while|each|from|this|that|into|dumbbells?|barbell|cables?|machine|bench)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 1000)]
    private static partial Regex EnglishWords();

    // Sinônimos que misturariam o glossário: o app usa "polia" (nunca "cabo") e "halter" (nunca "dumbbell").
    [GeneratedRegex(@"\b(cabos?|pesos livres)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 1000)]
    private static partial Regex ForbiddenSynonyms();

    [Fact]
    public void Seed_HasBetween250And350Exercises()
    {
        Seed.Exercises.Count.Should().BeInRange(250, 350);
        Seed.SeedVersion.Should().BeGreaterThanOrEqualTo(1);
    }

    [Fact]
    public void Seed_PointsToTheFixedSourceCommit()
    {
        Seed.SourceCommit.Should().MatchRegex("^[0-9a-f]{40}$");
        FromFreeExerciseDb.Should().OnlyContain(e => e.SourceCommit == Seed.SourceCommit);
    }

    // Os exercícios que o UniOver mesmo escreveu (fonte "uniover") não têm original em inglês.
    private static IEnumerable<SeedExercise> FromFreeExerciseDb => Seed.Exercises.Where(e => e.Source == ExerciseSources.FreeExerciseDb);

    private static IEnumerable<SeedExercise> Own => Seed.Exercises.Where(e => e.Source == ExerciseSources.Uniover);

    [Fact]
    public void EverySourceRef_ExistsInTheOriginalFile_AndIsUnique()
    {
        Seed.Exercises.Select(e => (e.Source, e.SourceRef)).Should().OnlyHaveUniqueItems();
        foreach (var exercise in FromFreeExerciseDb)
        {
            Originals.Value.Should().ContainKey(exercise.SourceRef);
        }
    }

    [Fact]
    public void OwnExercises_AreTheProposedListWithTheirOwnSource_AndNeverCollideWithTheOriginals()
    {
        Seed.Exercises.Select(e => e.Source).Distinct().Should().BeEquivalentTo([ExerciseSources.FreeExerciseDb, ExerciseSources.Uniover]);
        Own.Should().HaveCount(37);
        Own.Should().OnlyContain(e => e.SourceRef == e.Slug && e.SourceCommit == "uniover");
        Own.Select(e => e.Equipment).Distinct().Should().Contain([Equipment.Kettlebell, Equipment.Band, Equipment.Cardio]);
        Own.Where(e => e.Equipment == Equipment.Cardio).Should().OnlyContain(e => e.RecordType == ExerciseRecordTypes.Time);
        Seed.SeedVersion.Should().BeGreaterThanOrEqualTo(2);
    }

    [Fact]
    public void Slugs_AreUnique_AndMatchTheNameExactly()
    {
        Seed.Exercises.Select(e => e.Slug).Should().OnlyHaveUniqueItems();
        foreach (var exercise in Seed.Exercises)
        {
            exercise.Slug.Should().Be(TextNormalizer.Slugify(exercise.Name), $"o slug de '{exercise.Name}' sai do nome");
            exercise.Slug.Should().NotBeEmpty();
            exercise.Slug.Length.Should().BeLessThanOrEqualTo(100);
        }
    }

    [Fact]
    public void Names_AreUnique_WithoutAccentsOrCase()
    {
        Seed.Exercises.Select(e => TextNormalizer.Fold(e.Name)).Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void Vocabulary_IsClosed()
    {
        foreach (var e in Seed.Exercises)
        {
            Equipment.IsValid(e.Equipment).Should().BeTrue($"equipamento '{e.Equipment}' de '{e.Name}'");
            ExerciseRecordTypes.IsValid(e.RecordType).Should().BeTrue($"tipo de registro '{e.RecordType}' de '{e.Name}'");
            e.PrimaryMuscles.Should().OnlyContain(m => Muscle.IsValid(m), $"músculos principais de '{e.Name}'");
            e.SecondaryMuscles.Should().OnlyContain(m => Muscle.IsValid(m), $"músculos secundários de '{e.Name}'");
        }
    }

    [Fact]
    public void Muscles_FollowTheRules_OneToThreePrimary_DistinctAndNeverBothPrimaryAndSecondary()
    {
        foreach (var e in Seed.Exercises)
        {
            e.PrimaryMuscles.Count.Should().BeInRange(1, Exercise.MusclesMax, e.Name);
            e.PrimaryMuscles.Should().OnlyHaveUniqueItems(e.Name);
            e.SecondaryMuscles.Should().OnlyHaveUniqueItems(e.Name);
            e.SecondaryMuscles.Should().NotIntersectWith(e.PrimaryMuscles, e.Name);
        }
    }

    [Fact]
    public void NoText_IsEmpty_AndTheLimitsOfTheColumnsAreRespected()
    {
        foreach (var e in Seed.Exercises)
        {
            e.Name.Should().NotBeNullOrWhiteSpace();
            e.Name.Length.Should().BeLessThanOrEqualTo(Exercise.NameMax, e.Name);
            e.Instructions.Count.Should().BeInRange(1, Exercise.InstructionsMax, e.Name);
            foreach (var step in e.Instructions)
            {
                step.Should().NotBeNullOrWhiteSpace(e.Name);
                step.Length.Should().BeLessThanOrEqualTo(Exercise.InstructionMax, e.Name);
            }

            (e.Level?.Length ?? 0).Should().BeLessThanOrEqualTo(40);
            (e.Category?.Length ?? 0).Should().BeLessThanOrEqualTo(40);
            (e.Mechanic?.Length ?? 0).Should().BeLessThanOrEqualTo(40);
        }
    }

    [Fact]
    public void NoInstruction_IsIdenticalToTheEnglishOriginal_AndNoNameEither()
    {
        foreach (var e in FromFreeExerciseDb)
        {
            var original = Originals.Value[e.SourceRef];
            e.Instructions.Should().NotIntersectWith(original.Instructions, $"as instruções de '{e.Name}' devem ser reescritas");
            TextNormalizer.Fold(e.Name).Should().NotBe(TextNormalizer.Fold(original.Name));
        }
    }

    [Fact]
    public void ThereIsNoLeftoverEnglish_InNamesOrInstructions()
    {
        foreach (var e in Seed.Exercises)
        {
            EnglishWords().IsMatch(e.Name).Should().BeFalse($"o nome '{e.Name}' tem palavra em inglês");
            foreach (var step in e.Instructions)
            {
                EnglishWords().IsMatch(step).Should().BeFalse($"a instrução de '{e.Name}' tem palavra em inglês: {step}");
            }
        }
    }

    [Fact]
    public void Glossary_NeverMixesSynonyms()
    {
        foreach (var e in Seed.Exercises)
        {
            ForbiddenSynonyms().IsMatch(e.Name).Should().BeFalse($"nome: {e.Name}");
            foreach (var step in e.Instructions)
            {
                ForbiddenSynonyms().IsMatch(step).Should().BeFalse($"instrução de '{e.Name}': {step}");
            }
        }
    }

    [Fact]
    public void Glossary_TheEquipmentTermInTheNameAgreesWithTheEquipment()
    {
        foreach (var e in Seed.Exercises)
        {
            var name = TextNormalizer.Fold(e.Name);
            if (Regex.IsMatch(name, @"\bhalteres?\b", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)))
            {
                e.Equipment.Should().Be(Equipment.Dumbbell, $"'{e.Name}' fala em halter");
            }

            if (Regex.IsMatch(name, @"\bpolia\b", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)))
            {
                e.Equipment.Should().Be(Equipment.Cable, $"'{e.Name}' fala em polia");
            }

            if (Regex.IsMatch(name, @"\b(maquina|smith)\b", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)))
            {
                e.Equipment.Should().Be(Equipment.Machine, $"'{e.Name}' fala em máquina");
            }

            if (name.Contains("barra w", StringComparison.Ordinal))
            {
                e.Equipment.Should().Be(Equipment.Barbell, $"'{e.Name}' fala em barra W");
            }

            if (name.Contains("kettlebell", StringComparison.Ordinal))
            {
                e.Equipment.Should().Be(Equipment.Kettlebell, $"'{e.Name}' fala em kettlebell");
            }

            if (name.Contains("elastico", StringComparison.Ordinal) || name.Contains("mini band", StringComparison.Ordinal))
            {
                e.Equipment.Should().Be(Equipment.Band, $"'{e.Name}' fala em elástico");
            }
        }
    }

    [Fact]
    public void RecordType_IsCoherent_TimeOnlyForHoldsAndRepsOnlyOnlyForBodyweight()
    {
        foreach (var e in Seed.Exercises)
        {
            if (e.RecordType == ExerciseRecordTypes.RepsOnly)
            {
                e.Equipment.Should().BeOneOf(Equipment.Bodyweight, Equipment.Other, Equipment.Band);
            }

            if (e.Equipment == Equipment.Bodyweight && e.RecordType == ExerciseRecordTypes.WeightReps)
            {
                TextNormalizer.Fold(e.Name).Should().Contain("peso", $"'{e.Name}' de peso do corpo só tem carga se o nome diz");
            }
        }

        Seed.Exercises.Should().Contain(e => e.RecordType == ExerciseRecordTypes.Time);
    }

    [Fact]
    public void Seed_IsMarkedAsNotReviewedYet()
    {
        Seed.Exercises.Should().OnlyContain(e => !e.Reviewed);
    }

    [Fact]
    public void Seed_CoversEveryMuscleGroup_AndEveryEquipmentOfTheCatalog()
    {
        var groups = Seed.Exercises.Select(e => MuscleGroup.Of(e.PrimaryMuscles[0])).Distinct();
        var equipment = Seed.Exercises.Select(e => e.Equipment).Distinct();

        groups.Should().BeEquivalentTo(MuscleGroup.All);
        equipment.Should().Contain([Equipment.Barbell, Equipment.Dumbbell, Equipment.Machine, Equipment.Cable, Equipment.Bodyweight]);
    }
}
