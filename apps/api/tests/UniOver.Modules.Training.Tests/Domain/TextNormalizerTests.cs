using AwesomeAssertions;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Tests.Domain;

public class TextNormalizerTests
{
    [Theory]
    [InlineData("Supino Reto", "supino reto")]
    [InlineData("  Rosca   Martelo  ", "rosca martelo")]
    [InlineData("Elevação pélvica", "elevacao pelvica")]
    [InlineData("TRÍCEPS TESTA", "triceps testa")]
    [InlineData("Panturrilha em pé", "panturrilha em pe")]
    [InlineData("Glúteo-isquio no solo", "gluteo-isquio no solo")]
    [InlineData("Coice de glúteo", "coice de gluteo")]
    [InlineData("Abdução", "abducao")]
    public void Fold_RemovesAccentsAndCase(string input, string expected)
    {
        TextNormalizer.Fold(input).Should().Be(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Fold_OfNothing_IsEmpty(string? input)
    {
        TextNormalizer.Fold(input).Should().BeEmpty();
    }

    [Fact]
    public void Fold_MakesSupinoFindSupinoReto()
    {
        TextNormalizer.Fold("Supino reto com barra").Should().Contain(TextNormalizer.Fold("SUPINO"));
    }

    [Theory]
    [InlineData("Supino reto com barra", "supino-reto-com-barra")]
    [InlineData("Dead bug (inseto morto)", "dead-bug-inseto-morto")]
    [InlineData("Elevação pélvica com barra", "elevacao-pelvica-com-barra")]
    [InlineData("  --Agachamento / hack--  ", "agachamento-hack")]
    [InlineData("Tríceps na polia, pegada supinada", "triceps-na-polia-pegada-supinada")]
    public void Slugify_KeepsOnlyLettersDigitsAndSingleDashes(string input, string expected)
    {
        TextNormalizer.Slugify(input).Should().Be(expected);
    }

    [Fact]
    public void Slugify_OfTextWithoutLettersOrDigits_IsEmpty()
    {
        TextNormalizer.Slugify("!!! ???").Should().BeEmpty();
    }

    [Fact]
    public void SlugWithId_DiffersForTwoExercisesWithTheSameName()
    {
        var a = TextNormalizer.SlugWithId("Meu exercício", Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ab"));
        var b = TextNormalizer.SlugWithId("Meu exercício", Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789cd"));

        a.Should().NotBe(b);
        a.Should().StartWith("meu-exercicio-");
    }

    [Fact]
    public void SlugWithId_NeverPassesTheColumnLimit()
    {
        var slug = TextNormalizer.SlugWithId(new string('a', 400), Guid.NewGuid());

        slug.Length.Should().BeLessThanOrEqualTo(100);
    }

    [Fact]
    public void SlugWithId_OfNameWithoutLetters_FallsBackToTheIdSuffix()
    {
        var id = Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ab");

        TextNormalizer.SlugWithId("???", id).Should().Be("456789ab");
    }
}
