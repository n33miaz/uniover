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
    public void TheNameIsStoredAndCompared_NormalizedLikeAnyOtherText()
    {
        var tv = ConfiguredTv.CreateDefault("TV\U000000A0 da   sala", "pc-casa", Admin, Now);

        tv.Name.Should().Be("TV da sala");
        tv.Rebind("pc-casa", "TV da sala ", Admin, Now.AddMinutes(1)).Should().BeFalse("só os espaços mudaram");
    }

    [Theory]
    [InlineData("\U0000202Eatv")]
    [InlineData("TV\U0000200Bsala")]
    [InlineData("TV\nsala")]
    public void ANameWithInvisibleOrControlCharacters_IsNeverStored_EvenIfTheValidationWasBypassed(string name)
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);

        FluentActions.Invoking(() => ConfiguredTv.CreateDefault(name, "pc-casa", Admin, Now)).Should().Throw<ArgumentException>();
        FluentActions.Invoking(() => tv.Rebind("pc-novo", name, Admin, Now)).Should().Throw<ArgumentException>();
        tv.AgentSlug.Should().Be("pc-casa", "a falha acontece antes de qualquer mudança");
    }

    [Fact]
    public void Rebind_WithOnlyANewName_IsAChange()
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);

        tv.Rebind("pc-casa", "Sala", Admin, Now.AddMinutes(1)).Should().BeTrue();

        tv.Name.Should().Be("Sala");
    }

    [Fact]
    public void BackgroundAppClosing_StartsOff_AndOnlyAChangeStampsWhoAndWhen()
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);
        tv.AllowBackgroundAppClosing.Should().BeFalse("a regra do dono é não mexer nos apps sem opção explícita");

        tv.SetBackgroundAppClosing(false, Guid.NewGuid(), Now.AddMinutes(1)).Should().BeFalse();
        tv.UpdatedAt.Should().Be(Now);

        var other = Guid.NewGuid();
        tv.SetBackgroundAppClosing(true, other, Now.AddMinutes(2)).Should().BeTrue();
        (tv.AllowBackgroundAppClosing, tv.UpdatedBy, tv.UpdatedAt).Should().Be((true, other, Now.AddMinutes(2)));

        tv.SetBackgroundAppClosing(false, Admin, Now.AddMinutes(3)).Should().BeTrue();
        tv.AllowBackgroundAppClosing.Should().BeFalse();
    }

    [Fact]
    public void AutoMaintenance_StartsOn_AndOnlyAChangeStampsWhoAndWhen()
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);
        tv.AutoMaintenanceEnabled.Should().BeTrue("a manutenção da Samsung vem ligada por padrão");

        tv.SetAutoMaintenance(true, Guid.NewGuid(), Now.AddMinutes(1)).Should().BeFalse();
        tv.UpdatedAt.Should().Be(Now);

        var other = Guid.NewGuid();
        tv.SetAutoMaintenance(false, other, Now.AddMinutes(2)).Should().BeTrue();
        (tv.AutoMaintenanceEnabled, tv.UpdatedBy, tv.UpdatedAt).Should().Be((false, other, Now.AddMinutes(2)));

        tv.SetAutoMaintenance(true, Admin, Now.AddMinutes(3)).Should().BeTrue();
        tv.AutoMaintenanceEnabled.Should().BeTrue();
    }

    [Fact]
    public void LightSettings_StartOff_AndOnlyAChangeStampsWhoAndWhen()
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);
        (tv.FocusModeEnabled, tv.ShortAnimationsEnabled).Should().Be((false, false));
        tv.BackgroundPackages().Should().BeEmpty();

        tv.SetLightSettings(null, null, null, Guid.NewGuid(), Now.AddMinutes(1)).Should().BeFalse();
        tv.SetLightSettings(false, false, [], Guid.NewGuid(), Now.AddMinutes(1)).Should().BeFalse();
        tv.UpdatedAt.Should().Be(Now);

        tv.SetLightSettings(true, null, ["com.exemplo.b", "com.exemplo.a", "com.exemplo.a"], Admin, Now.AddMinutes(2)).Should().BeTrue();
        (tv.FocusModeEnabled, tv.ShortAnimationsEnabled).Should().Be((true, false));
        tv.BackgroundPackages().Should().Equal("com.exemplo.a", "com.exemplo.b");
    }

    [Fact]
    public void FocusClosesBackground_StartsOff_AndOnlyAChangeCounts()
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);
        tv.FocusClosesBackground.Should().BeFalse();

        tv.SetLightSettings(null, null, null, Admin, Now.AddMinutes(1), false).Should().BeFalse();
        tv.SetLightSettings(true, null, null, Admin, Now.AddMinutes(2), true).Should().BeTrue();
        (tv.FocusModeEnabled, tv.FocusClosesBackground).Should().Be((true, true));
        tv.SetLightSettings(null, null, null, Admin, Now.AddMinutes(3), true).Should().BeFalse();
        tv.SetLightSettings(null, null, null, Admin, Now.AddMinutes(4), false).Should().BeTrue();
        tv.FocusClosesBackground.Should().BeFalse();
    }

    [Theory]
    [InlineData("android")]
    [InlineData("com.android.systemui")]
    [InlineData("com.android.vending")]
    [InlineData("com.google.android.tv.remote.service")]
    [InlineData("com.google.android.tvlauncher")]
    [InlineData("com.google.android.inputmethod.latin")]
    [InlineData("com.android.providers.media")]
    [InlineData("com.tcl.launcher")]
    [InlineData("com.exemplo.remote_control")]
    [InlineData("nome invalido; rm -rf /")]
    public void LightSettings_NeverKeepASystemLauncherKeyboardOrRemoteControlPackage(string package)
    {
        var tv = ConfiguredTv.CreateDefault("TV", "pc-casa", Admin, Now);

        tv.SetLightSettings(null, null, [package, "com.exemplo.video"], Admin, Now.AddMinutes(1));

        tv.BackgroundPackages().Should().Equal("com.exemplo.video");
    }

    [Fact]
    public void IsValidRestrictedPackages_AcceptsNothingOrACleanList()
    {
        ConfiguredTv.IsValidRestrictedPackages(null).Should().BeTrue();
        ConfiguredTv.IsValidRestrictedPackages([]).Should().BeTrue();
        ConfiguredTv.IsValidRestrictedPackages(["com.exemplo.a", "com.exemplo.b"]).Should().BeTrue();
    }

    [Fact]
    public void IsValidRestrictedPackages_RefusesWhatTheAgentOrTheColumnCannotTake()
    {
        ConfiguredTv.IsValidRestrictedPackages([.. Enumerable.Range(0, 101).Select(i => $"com.exemplo.app{i}")]).Should().BeFalse();
        ConfiguredTv.IsValidRestrictedPackages([.. Enumerable.Range(0, 100).Select(i => $"com.exemplo.aplicativo.com.nome.bem.longo{i}")]).Should().BeFalse();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("semponto")]
    [InlineData("com.exemplo; reboot")]
    [InlineData("com.android.vending")]
    [InlineData("com.google.android.tv.remote.service")]
    public void IsValidRestrictedPackages_RefusesANullInvalidOrProtectedItem(string? item)
    {
        ConfiguredTv.IsValidRestrictedPackages(["com.exemplo.a", item]).Should().BeFalse();
    }

    [Fact]
    public void IsValidRestrictedPackages_RefusesADuplicate()
    {
        ConfiguredTv.IsValidRestrictedPackages(["com.exemplo.a", "com.exemplo.a"]).Should().BeFalse();
    }
}
