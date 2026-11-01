using AwesomeAssertions;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Tests.Domain;

public class HomePreferenceRulesTests
{
    private static HomeEntry[] Entries(params string[] ids) => [.. ids.Select(id => new HomeEntry(id, true))];

    [Fact]
    public void Null_IsTheDefault_AndEmptyIsAChoice()
    {
        HomePreferenceRules.Validate(null).Should().BeNull();
        HomePreferenceRules.Validate([]).Should().BeNull();
    }

    [Theory]
    [InlineData("tv")]
    [InlineData("training")]
    [InlineData("backup-de-fotos")]
    [InlineData("m1")]
    public void Validate_AcceptsShortLowercaseIds(string id) =>
        HomePreferenceRules.Validate(Entries(id)).Should().BeNull();

    [Theory]
    [InlineData("")]
    [InlineData("TV")]
    [InlineData("-tv")]
    [InlineData("tv ")]
    [InlineData("tv/x")]
    [InlineData("tv_x")]
    [InlineData("tv\n")]
    [InlineData("módulo")]
    public void Validate_RefusesAnythingOutsideTheShape(string id) =>
        HomePreferenceRules.Validate(Entries(id)).Should().NotBeNull();

    [Fact]
    public void Validate_RefusesTooLongAnId_ADuplicate_ANullEntry_AndTooManyEntries()
    {
        HomePreferenceRules.Validate(Entries(new string('a', HomePreferenceRules.MaxIdLength + 1))).Should().NotBeNull();
        HomePreferenceRules.Validate(Entries(new string('a', HomePreferenceRules.MaxIdLength))).Should().BeNull();
        HomePreferenceRules.Validate(Entries("tv", "tv")).Should().NotBeNull();
        HomePreferenceRules.Validate([null]).Should().NotBeNull();
        HomePreferenceRules.Validate(Entries([.. Enumerable.Range(0, HomePreferenceRules.MaxEntries + 1).Select(i => $"m{i}")])).Should().NotBeNull();
        HomePreferenceRules.Validate(Entries([.. Enumerable.Range(0, HomePreferenceRules.MaxEntries).Select(i => $"m{i}")])).Should().BeNull();
    }
}
