using AwesomeAssertions;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Siri;

namespace UniOver.Modules.Tv.Tests.Domain;

public class SiriTokenTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 31, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ANewSecret_HasThePrefix_AndOnlyItsHashIsKept()
    {
        var (token, hash) = SiriSecrets.New();

        token.Should().StartWith(SiriSecrets.Prefix);
        hash.Should().HaveCount(32).And.Equal(SiriSecrets.Hash(token));
        SiriSecrets.HashPresented(token).Should().Equal(hash);
    }

    [Fact]
    public void TwoSecrets_AreNeverEqual()
    {
        SiriSecrets.New().Token.Should().NotBe(SiriSecrets.New().Token);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("atalho_")]
    [InlineData("atalho_curto")]
    [InlineData("uo_dev_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("atalho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+")]
    public void APresentedTextThatIsNotAKeyOfOurs_HasNoHash(string? presented) =>
        SiriSecrets.HashPresented(presented).Should().BeNull();

    [Fact]
    public void ATextLongerThanAnyKey_HasNoHash() =>
        SiriSecrets.HashPresented(SiriSecrets.Prefix + new string('A', 200)).Should().BeNull();

    [Fact]
    public void AToken_IsUsableUntilItIsRevokedOrExpires()
    {
        var token = SiriToken.Create(Guid.NewGuid(), Guid.NewGuid(), "iPhone", SiriSecrets.New().Hash, ["volume_up"], Now, Now.AddDays(1));

        token.IsUsable(Now).Should().BeTrue();
        token.IsUsable(Now.AddDays(1).AddTicks(-1)).Should().BeTrue();
        token.IsUsable(Now.AddDays(1)).Should().BeFalse("o instante do vencimento já não vale");

        token.Revoke(Now);
        token.IsUsable(Now).Should().BeFalse();
    }

    [Fact]
    public void ATokenWithoutExpiry_NeverExpires()
    {
        var token = SiriToken.Create(Guid.NewGuid(), Guid.NewGuid(), "iPhone", SiriSecrets.New().Hash, ["mute"], Now, expiresAt: null);

        token.IsUsable(Now.AddYears(20)).Should().BeTrue();
    }

    [Fact]
    public void Revoking_KeepsTheFirstMoment()
    {
        var token = SiriToken.Create(Guid.NewGuid(), Guid.NewGuid(), "iPhone", SiriSecrets.New().Hash, ["mute"], Now, null);

        token.Revoke(Now);
        token.Revoke(Now.AddHours(5));

        token.RevokedAt.Should().Be(Now);
    }
}

public class SiriActionsTests
{
    [Theory]
    [InlineData("power_off", null, null, "power_off")]
    [InlineData("volume_up", null, null, "volume_up")]
    [InlineData("volume_down", null, null, "volume_down")]
    [InlineData("mute", null, null, "mute")]
    [InlineData("key", "HOME", null, "key:HOME")]
    [InlineData(" key ", " BACK ", null, "key:BACK")]
    public void AValidRequest_BecomesItsStableCode(string action, string? key, string? app, string expected) =>
        SiriActions.CodeOf(action, key, app).Should().Be(expected);

    [Fact]
    public void AnAppRequest_BecomesTheCanonicalIdCode()
    {
        var id = Guid.NewGuid();

        SiriActions.CodeOf("app", null, id.ToString("N")).Should().Be($"app:{id}");
        SiriActions.CodeOf("app", null, id.ToString().ToUpperInvariant()).Should().Be($"app:{id}");
    }

    [Theory]
    [InlineData(null, null, null)]
    [InlineData("", null, null)]
    [InlineData("wake", null, null)]
    [InlineData("ligar", null, null)]
    [InlineData("POWER_OFF", null, null)]
    [InlineData("key", null, null)]
    [InlineData("key", "POWER", null)]
    [InlineData("key", "VOLUME_UP", null)]
    [InlineData("key", "home", null)]
    [InlineData("key", "HOME", "00000000-0000-0000-0000-000000000001")]
    [InlineData("volume_up", "HOME", null)]
    [InlineData("mute", null, "x")]
    [InlineData("app", null, null)]
    [InlineData("app", null, "não é id")]
    [InlineData("app", null, "00000000-0000-0000-0000-000000000000")]
    [InlineData("app", "HOME", "00000000-0000-0000-0000-000000000001")]
    public void AnInvalidRequest_HasNoCode(string? action, string? key, string? app) =>
        SiriActions.CodeOf(action, key, app).Should().BeNull();

    [Fact]
    public void ThePowerKeyIsNeverOnTheKeyList_AndThereIsNoPowerOnAction()
    {
        SiriActions.Keys.Should().NotContain("POWER");
        SiriActions.IsWellFormed("key:POWER").Should().BeFalse();
        SiriActions.IsWellFormed("wake").Should().BeFalse();
        SiriActions.IsWellFormed("power_on").Should().BeFalse();
    }

    [Theory]
    [InlineData("power_off", "tv:power")]
    [InlineData("volume_up", "tv:control")]
    [InlineData("volume_down", "tv:control")]
    [InlineData("mute", "tv:control")]
    [InlineData("key:HOME", "tv:control")]
    public void EachActionNeedsThePermissionOfTheSameThingInTheApp(string code, string permission)
    {
        SiriActions.PermissionOf(code).Should().Be(permission);
        AccessPermissions.IsKnown(SiriActions.PermissionOf(code)).Should().BeTrue();
    }

    [Fact]
    public void OpeningAnApp_NeedsTheLaunchPermission() =>
        SiriActions.PermissionOf($"app:{Guid.NewGuid()}").Should().Be(AccessPermissions.TvLaunch);

    [Theory]
    [InlineData("volume_up", "VOLUME_UP")]
    [InlineData("volume_down", "VOLUME_DOWN")]
    [InlineData("mute", "MUTE")]
    [InlineData("key:HOME", "HOME")]
    [InlineData("power_off", null)]
    public void TheKeyOfAnAction_ComesFromTheClosedCatalog(string code, string? key) =>
        SiriActions.KeyOf(code).Should().Be(key);

    [Fact]
    public void EveryCatalogKey_IsAKeyOfTheContract()
    {
        foreach (var key in SiriActions.Keys.Concat(["VOLUME_UP", "VOLUME_DOWN", "MUTE"]))
        {
            UniOver.Modules.Tv.Adapters.TvMessages.Keys.ContainsKey(key).Should().BeTrue(key);
        }
    }
}
