using System.Security.Cryptography;
using System.Text;
using AwesomeAssertions;
using UniOver.Modules.Devices.Domain;

namespace UniOver.Modules.Devices.Tests.Domain;

public class DeviceSecretsTests
{
    [Fact]
    public void NewDeviceToken_HasThePrefixAndThirtyTwoRandomBytes()
    {
        var (token, hash) = DeviceSecrets.NewDeviceToken();

        token.Should().StartWith("uo_dev_");
        System.Buffers.Text.Base64Url.DecodeFromChars(token.AsSpan(DeviceSecrets.TokenPrefix.Length)).Should().HaveCount(32);
        hash.Should().HaveCount(32);
    }

    [Fact]
    public void NewDeviceToken_IsDifferentEveryTime()
    {
        DeviceSecrets.NewDeviceToken().Token.Should().NotBe(DeviceSecrets.NewDeviceToken().Token);
    }

    [Fact]
    public void TokenHash_IsTheSha256OfTheWholeText_NotTheTextItself()
    {
        var (token, hash) = DeviceSecrets.NewDeviceToken();

        hash.Should().Equal(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
        Convert.ToBase64String(hash).Should().NotContain(token);
        DeviceSecrets.HashToken(token).Should().Equal(hash);
    }

    [Fact]
    public void HashPresentedToken_AcceptsTheIssuedToken_AndRejectsAnythingElse()
    {
        var (token, hash) = DeviceSecrets.NewDeviceToken();

        DeviceSecrets.HashPresentedToken(token).Should().Equal(hash);
        DeviceSecrets.HashPresentedToken(null).Should().BeNull();
        DeviceSecrets.HashPresentedToken("").Should().BeNull();
        DeviceSecrets.HashPresentedToken("uo_dev_curto").Should().BeNull();
        DeviceSecrets.HashPresentedToken("outro_" + token[7..]).Should().BeNull();
        DeviceSecrets.HashPresentedToken(token + "AAAA").Should().BeNull();
        DeviceSecrets.HashPresentedToken("uo_dev_" + new string('!', 43)).Should().BeNull();
    }

    [Fact]
    public void DeviceCode_HashesToItsSha256_AndMalformedInputIsRejected()
    {
        var (code, hash) = DeviceSecrets.NewDeviceCode();

        DeviceSecrets.HashDeviceCode(code).Should().Equal(hash);
        DeviceSecrets.HashDeviceCode("curto").Should().BeNull();
        DeviceSecrets.HashDeviceCode(null).Should().BeNull();
        DeviceSecrets.HashDeviceCode(new string('A', 200)).Should().BeNull();
        DeviceSecrets.HashDeviceCode(new string('!', 43)).Should().BeNull();
    }

    [Fact]
    public void Matches_ComparesHashes_AndRefusesNullOrDifferentOnes()
    {
        var (_, first) = DeviceSecrets.NewDeviceToken();
        var (_, second) = DeviceSecrets.NewDeviceToken();

        DeviceSecrets.Matches(first, [.. first]).Should().BeTrue();
        DeviceSecrets.Matches(first, second).Should().BeFalse();
        DeviceSecrets.Matches(null, first).Should().BeFalse();
        DeviceSecrets.Matches([1, 2], first).Should().BeFalse();
    }
}
