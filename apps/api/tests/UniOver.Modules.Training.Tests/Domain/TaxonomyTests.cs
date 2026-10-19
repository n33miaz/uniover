using AwesomeAssertions;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Tests.Domain;

public class TaxonomyTests
{
    [Fact]
    public void EveryMuscle_HasExactlyOneGroup_FromTheClosedSetOfGroups()
    {
        foreach (var muscle in Muscle.All)
        {
            MuscleGroup.Map.Should().ContainKey(muscle, $"o músculo '{muscle}' precisa de grupo para o filtro da tela");
            MuscleGroup.All.Should().Contain(MuscleGroup.Of(muscle));
        }
    }

    [Fact]
    public void MuscleGroupMap_HasNoMuscleOutsideTheClosedSet()
    {
        // O mapa não pode ter sobra: músculo no mapa e fora da lista seria valor sem validação nas bordas.
        MuscleGroup.Map.Keys.Should().BeEquivalentTo(Muscle.All);
    }

    [Fact]
    public void EveryGroup_IsUsedByAtLeastOneMuscle()
    {
        MuscleGroup.All.Should().BeEquivalentTo(MuscleGroup.Map.Values.Distinct());
    }

    [Fact]
    public void MuscleGroupOf_RejectsAMuscleWithoutGroup()
    {
        var act = () => MuscleGroup.Of("pinky_toe");

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void MuscleIds_AreStableSnakeCase()
    {
        foreach (var id in Muscle.All)
        {
            id.All(c => c is (>= 'a' and <= 'z') or '_').Should().BeTrue(id);
        }

        Muscle.All.Should().OnlyHaveUniqueItems();
        Muscle.IsValid("lower_back").Should().BeTrue();
        Muscle.IsValid("lower back").Should().BeFalse();
        Muscle.IsValid(null).Should().BeFalse();
    }

    [Theory]
    [InlineData(Equipment.Barbell, 2.5)]
    [InlineData(Equipment.Dumbbell, 2)]
    [InlineData(Equipment.Machine, 5)]
    [InlineData(Equipment.Cable, 5)]
    [InlineData(Equipment.Bodyweight, 0)]
    [InlineData(Equipment.Other, 0)]
    public void DefaultStep_FollowsTheOwnersChoice(string equipment, double expected)
    {
        Equipment.DefaultStepKg(equipment).Should().Be((decimal)expected);
    }

    [Fact]
    public void EveryEquipment_HasADefaultStep()
    {
        foreach (var equipment in Equipment.All)
        {
            var act = () => Equipment.DefaultStepKg(equipment);

            act.Should().NotThrow($"o equipamento '{equipment}' precisa de salto padrão");
        }
    }

    [Fact]
    public void DefaultStep_RejectsEquipmentOutsideTheClosedSet()
    {
        var act = () => Equipment.DefaultStepKg("kettlebell");

        act.Should().Throw<ArgumentOutOfRangeException>();
        Equipment.IsValid("kettlebell").Should().BeFalse();
    }
}
