using AwesomeAssertions;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Features.Routines.ListRoutineTemplates;

namespace UniOver.Modules.Training.Tests.Routines;

/// <summary>Conteúdo dos modelos de rotina embutidos: slugs reais, faixas válidas e superséries contíguas.</summary>
public class RoutineTemplatesTests
{
    private static readonly RoutineTemplatesResponse Templates = RoutineTemplateSource.Read();
    private static readonly HashSet<string> CatalogSlugs = [.. CatalogSeedSource.Read().Exercises.Select(e => e.Slug)];

    private static IEnumerable<(RoutineTemplate Template, RoutineTemplateRoutine Routine)> AllRoutines() =>
        Templates.Items.SelectMany(t => t.Routines.Select(r => (t, r)));

    [Fact]
    public void ThereAreThreeTemplates_AbcAbcdAndFullBody()
    {
        Templates.Items.Select(t => t.Id).Should().Equal("abc", "abcd", "full-body");
        Templates.Items.Select(t => t.Routines.Count).Should().Equal(3, 4, 2);
    }

    [Fact]
    public void EveryTemplateHasAnIdNameAndDescription_AndIdsAreUnique()
    {
        Templates.Items.Should().OnlyContain(t => !string.IsNullOrWhiteSpace(t.Id) && !string.IsNullOrWhiteSpace(t.Name) && !string.IsNullOrWhiteSpace(t.Description));
        Templates.Items.Select(t => t.Id).Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void EveryRoutineHasANameWithinTheLimit_AndNamesAreUniqueInsideTheTemplate()
    {
        foreach (var template in Templates.Items)
        {
            template.Routines.Should().OnlyContain(r => r.Name.Length >= 1 && r.Name.Length <= RoutineLimits.NameMax);
            template.Routines.Select(r => r.Name).Should().OnlyHaveUniqueItems(template.Id);
        }
    }

    [Fact]
    public void EveryExerciseSlug_ExistsInTheCatalogSeed()
    {
        var missing = AllRoutines().SelectMany(x => x.Routine.Items).Select(i => i.ExerciseSlug).Where(s => !CatalogSlugs.Contains(s)).Distinct();

        missing.Should().BeEmpty("o modelo referencia exercícios pelo slug do catálogo");
    }

    [Fact]
    public void EveryItemRespectsTheRoutineLimits()
    {
        foreach (var (template, routine) in AllRoutines())
        {
            foreach (var item in routine.Items)
            {
                var where = $"{template.Id}/{routine.Name}/{item.ExerciseSlug}";
                item.TargetSets.Should().BeInRange(RoutineLimits.SetsMin, RoutineLimits.SetsMax, where);
                item.RepMin.Should().BeInRange(RoutineLimits.RepsMin, RoutineLimits.RepsMax, where);
                item.RepMax.Should().BeInRange(RoutineLimits.RepsMin, RoutineLimits.RepsMax, where);
                item.RepMin.Should().BeLessThanOrEqualTo(item.RepMax, where);
                item.RestSeconds.Should().BeInRange(0, RoutineLimits.RestMax, where);
                if (item.SupersetGroup is { } group)
                {
                    group.Should().BeInRange(RoutineLimits.SupersetGroupMin, RoutineLimits.SupersetGroupMax, where);
                }
            }
        }
    }

    [Fact]
    public void EveryRoutine_HasAtMost40Items_AndAtLeastOne()
    {
        AllRoutines().Should().OnlyContain(x => x.Routine.Items.Count >= 1 && x.Routine.Items.Count <= RoutineLimits.MaxItems);
    }

    [Fact]
    public void Supersets_AreContiguous_AndNeverALoneItem()
    {
        foreach (var (template, routine) in AllRoutines())
        {
            var specs = routine.Items
                .Select((item, index) => new RoutineItemSpec(Guid.NewGuid(), Guid.NewGuid(), index, item.TargetSets, item.RepMin, item.RepMax, item.RestSeconds, item.SupersetGroup, null))
                .ToList();
            var label = $"{template.Id}/{routine.Name}";

            RoutineRules.SupersetsAreContiguous(specs).Should().BeTrue(label);
            RoutineRules.NormalizeSupersets(specs).Select(s => s.SupersetGroup).Should().Equal(specs.Select(s => s.SupersetGroup), label + ": grupo de um item só");
        }
    }

    [Fact]
    public void NoRoutineRepeatsTheSameExercise()
    {
        foreach (var (template, routine) in AllRoutines())
        {
            routine.Items.Select(i => i.ExerciseSlug).Should().OnlyHaveUniqueItems($"{template.Id}/{routine.Name}");
        }
    }
}
