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
    public void ExistingTemplatesAndFiveOptionalPlansAreAllPresent()
    {
        Templates.Items.Select(t => t.Id).Should().Equal(
            "abc", "abcd", "full-body",
            "ppl-superior-inferior", "superior-inferior-acessorios", "divisao-familiar-reforco-inferior",
            "ab-reajustado", "full-body-cardio", "historical-ab");
        Templates.Items.Select(t => t.Routines.Count).Should().Equal(3, 4, 2, 5, 5, 5, 2, 3, 2);
    }

    [Fact]
    public void OptionalPlansShowTheSessionEstimateAndPreserveNonStrengthScheduleNotes()
    {
        var optional = Templates.Items.Skip(3).Take(5).ToList();
        optional.Should().OnlyContain(t => t.Description.Contains("45–60 min", StringComparison.Ordinal));
        optional.Should().OnlyContain(t => t.Description.StartsWith("Rascunho parcial", StringComparison.Ordinal));
        optional.Should().OnlyContain(t => t.Description.Contains("confira antes de criar", StringComparison.Ordinal));

        var ab = Templates.Items.Single(t => t.Id == "ab-reajustado");
        ab.Description.Should().Contain("não a ficha original do professor");
        ab.Description.Should().Contain("opcional, sem recomendação automática");

        var cardio = Templates.Items.Single(t => t.Id == "full-body-cardio");
        cardio.Description.Should().Contain("15–25 min").And.Contain("5–8 min");
        cardio.Description.Should().Contain("O app não agenda esses dias");
        cardio.Description.Should().Contain("20–40 s");

        Templates.Items.Single(t => t.Id == "divisao-familiar-reforco-inferior")
            .Description.Should().Contain("fica sem exercício de bíceps");
    }

    [Fact]
    public void OptionalPlansKeepTheirSupportedExerciseCountsAndDiscloseCatalogGaps()
    {
        var plans = Templates.Items.Skip(3).Take(5).ToDictionary(t => t.Id);
        plans["ppl-superior-inferior"].Routines.Select(r => r.Items.Count).Should().Equal(5, 4, 4, 5, 5);
        plans["superior-inferior-acessorios"].Routines.Select(r => r.Items.Count).Should().Equal(5, 3, 4, 5, 4);
        plans["divisao-familiar-reforco-inferior"].Routines.Select(r => r.Items.Count).Should().Equal(4, 3, 4, 3, 5);
        plans["ab-reajustado"].Routines.Select(r => r.Items.Count).Should().Equal(6, 5);
        plans["full-body-cardio"].Routines.Select(r => r.Items.Count).Should().Equal(4, 5, 3);

        plans.Values.Select(t => t.Description).Should().OnlyContain(d =>
            d.Contains("omitid", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void HistoricalOriginalAbKeepsOnlyClearItemsAndDisclosesItsLimits()
    {
        var historical = Templates.Items.Single(t => t.Id == "historical-ab");

        historical.Name.Should().Be("A/B histórico rejeitado");
        historical.Description.Should().StartWith("Histórico · rejeitado pelo dono · rascunho parcial.");
        historical.Description.Should().Contain("Não é recomendação");
        historical.Description.Should().Contain("nunca será ativado automaticamente");
        historical.Description.Should().Contain("padrão editável de 90 s");
        historical.Description.Should().Contain("esse valor não veio da ficha");
        historical.Description.Should().Contain("não confirma a alternância semanal");
        historical.Description.Should().Contain("as sessões caibam em 45–60 minutos");
        historical.Routines.Select(r => r.Name).Should().Equal(
            "A · Histórico rejeitado", "B · Histórico rejeitado");
        historical.Routines.Select(r => r.Items.Count).Should().Equal(2, 5);
        historical.Routines.SelectMany(r => r.Items).Select(i =>
            (i.ExerciseSlug, i.TargetSets, i.RepMin, i.RepMax, i.RestSeconds)).Should().Equal(
            ("crucifixo-na-maquina-voador", 3, 10, 10, 90),
            ("cadeira-extensora", 3, 10, 10, 90),
            ("puxada-aberta-na-polia", 3, 10, 10, 90),
            ("puxada-supinada-na-polia", 3, 10, 10, 90),
            ("crucifixo-inverso-na-maquina", 3, 10, 10, 90),
            ("mesa-flexora", 3, 10, 10, 90),
            ("abdominal-crunch", 3, 20, 20, 90));
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
