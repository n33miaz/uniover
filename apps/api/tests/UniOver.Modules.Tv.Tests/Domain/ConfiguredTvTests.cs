using AwesomeAssertions;
using UniOver.Modules.Tv.Domain;

namespace UniOver.Modules.Tv.Tests.Domain;

public class ConfiguredTvTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
    private static readonly Guid Admin = Guid.NewGuid();

    [Fact]
    public void CreateDefault_IsTheDefaultTv_WithTheAdministratorAndTheTime()
    {
        var tv = ConfiguredTv.CreateDefault("  TV da sala  ", "pc-casa", Admin, Now);

        tv.IsDefault.Should().BeTrue();
        tv.Name.Should().Be("TV da sala");
        tv.AgentSlug.Should().Be("pc-casa");
        tv.UpdatedBy.Should().Be(Admin);
        tv.CreatedAt.Should().Be(Now);
        tv.UpdatedAt.Should().Be(Now);
        tv.Id.Should().NotBeEmpty();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void CreateDefault_WithoutAName_UsesTheDefaultName(string? name) =>
        ConfiguredTv.CreateDefault(name, "pc-casa", Admin, Now).Name.Should().Be(ConfiguredTv.DefaultName);

    [Fact]
    public void Rebind_ToAnotherAgent_ChangesItAndStampsWhoAndWhen()
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);
        var other = Guid.NewGuid();
        var later = Now.AddHours(2);

        tv.Rebind("pc-novo", null, other, later).Should().BeTrue();

        tv.AgentSlug.Should().Be("pc-novo");
        tv.Name.Should().Be("TV", "nome ausente mantém o atual");
        tv.UpdatedBy.Should().Be(other);
        tv.UpdatedAt.Should().Be(later);
        tv.CreatedAt.Should().Be(Now);
    }

    [Fact]
    public void Rebind_ToTheSameAgentAndName_ChangesNothing()
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);

        tv.Rebind("pc-casa", "  TV ", Guid.NewGuid(), Now.AddHours(2)).Should().BeFalse();

        tv.UpdatedAt.Should().Be(Now);
        tv.UpdatedBy.Should().Be(Admin);
    }

    [Fact]
    public void Rebind_WithOnlyANewName_IsAChange()
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);

        tv.Rebind("pc-casa", "Sala", Admin, Now.AddMinutes(1)).Should().BeTrue();

        tv.Name.Should().Be("Sala");
    }
}
