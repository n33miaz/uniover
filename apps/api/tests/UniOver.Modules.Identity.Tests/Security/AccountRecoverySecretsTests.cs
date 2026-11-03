using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Security;

public sealed class AccountRecoverySecretsTests
{
    [Fact]
    public void TotpMatchesRfcVectorAndRejectsReuse()
    {
        var secret = Encoding.ASCII.GetBytes("12345678901234567890");
        var now = DateTimeOffset.FromUnixTimeSeconds(59);
        Assert.Equal("287082", TotpCodes.AtStep(secret, 1));
        Assert.Equal(1, TotpCodes.Match(secret, "287082", now));
        Assert.Null(TotpCodes.Match(secret, "287082", now, lastAcceptedStep: 1));
        Assert.Null(TotpCodes.Match(secret, "287O82", now));
    }

    [Fact]
    public void TotpProvisioningUsesAccountLabelAndSecret()
    {
        var secret = TotpCodes.NewSecret();
        var encoded = TotpCodes.ToBase32(secret);
        Assert.Equal(32, encoded.Length);
        var uri = TotpCodes.ProvisioningUri("owner@example.test", secret);
        Assert.Contains("secret=" + encoded, uri, StringComparison.Ordinal);
        Assert.Contains("UniOver%3Aowner%40example.test", uri, StringComparison.Ordinal);
        Assert.Contains("digits=6&period=30", uri, StringComparison.Ordinal);
    }

    [Fact]
    public void EncryptedTotpSecretBelongsOnlyToItsAccount()
    {
        var protector = new TotpSecretProtector(RandomNumberGenerator.GetBytes(32));
        var owner = Guid.NewGuid();
        var secret = TotpCodes.NewSecret();
        var encrypted = protector.Protect(owner, secret);
        Assert.NotEqual(secret, encrypted);
        Assert.Equal(secret, protector.Unprotect(owner, encrypted));
        Assert.ThrowsAny<CryptographicException>(() => protector.Unprotect(Guid.NewGuid(), encrypted));
        encrypted[^1] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => protector.Unprotect(owner, encrypted));
    }

    [Fact]
    public void RecoveryCodeIsRandomHashedAndStrictlyParsed()
    {
        var first = RecoveryCodes.Generate();
        var second = RecoveryCodes.Generate();
        Assert.Equal(32, first.Code.Length);
        Assert.NotEqual(first.Code, second.Code);
        Assert.Equal(first.Hash, RecoveryCodes.Hash(first.Code));
        Assert.Null(RecoveryCodes.Hash(first.Code + "x"));
        Assert.NotEqual(first.Hash, RecoveryCodes.Hash("00000000000000000000000000000000"));
    }

    [Fact]
    public async Task EmailDeliveryStaysOffWithoutExplicitConfiguration()
    {
        var sender = new ResendRecoveryEmailSender(new HttpClient(), Options.Create(new PasswordRecoveryEmailOptions()));
        Assert.False(sender.Available);
        Assert.False(await sender.TrySendAsync("owner@example.test", "token", CancellationToken.None));
        Assert.False(new PasswordRecoveryEmailOptions { Enabled = true }.IsValid());
        Assert.True(new PasswordRecoveryEmailOptions { Enabled = false }.IsValid());
    }
}
