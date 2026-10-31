using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using AwesomeAssertions;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Security;

public class DeviceProofTests
{
    private static readonly Guid Family = Guid.Parse("11111111-1111-7111-8111-111111111111");
    private static readonly Guid OtherFamily = Guid.Parse("22222222-2222-7222-8222-222222222222");
    private static readonly Guid Challenge = Guid.Parse("33333333-3333-7333-8333-333333333333");

    private static string PublicKeyOf(ECDsa key) => Base64Url.EncodeToString(key.ExportSubjectPublicKeyInfo());

    private static string Sign(ECDsa key, byte[] message) =>
        Base64Url.EncodeToString(key.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));

    [Fact]
    public void NormalizeKey_AcceptsAP256PublicKey_AndRejectsEverythingElse()
    {
        using var p256 = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var p384 = ECDsa.Create(ECCurve.NamedCurves.nistP384);

        DeviceProof.NormalizeKey(PublicKeyOf(p256)).Should().Be(PublicKeyOf(p256));
        DeviceProof.NormalizeKey(PublicKeyOf(p384)).Should().BeNull("só P-256");
        DeviceProof.NormalizeKey(null).Should().BeNull();
        DeviceProof.NormalizeKey("").Should().BeNull();
        DeviceProof.NormalizeKey("não é uma chave").Should().BeNull();
        DeviceProof.NormalizeKey("AAAA").Should().BeNull();
        DeviceProof.NormalizeKey(new string('A', DeviceProof.KeyMaxLength + 1)).Should().BeNull();
    }

    [Fact]
    public void ParseChallenge_ReadsIdAndNonce_AndRejectsTheMalformed()
    {
        var (nonce, hash) = DeviceProof.NewNonce();
        var text = DeviceProof.FormatChallenge(Challenge, nonce);

        var parsed = DeviceProof.ParseChallenge(text);

        parsed.Should().NotBeNull();
        parsed!.Value.Id.Should().Be(Challenge);
        parsed.Value.Nonce.Should().Be(nonce);
        parsed.Value.NonceHash.Should().Equal(hash);

        foreach (var bad in new[] { null, "", "semponto", $"{Challenge:N}.", $".{nonce}", $"{Challenge:N}.{nonce}.x", $"{Challenge:D}.{nonce}", $"{Challenge:N}.curto", new string('x', 101) })
        {
            DeviceProof.ParseChallenge(bad).Should().BeNull($"'{bad}'");
        }
    }

    [Fact]
    public void NewNonce_IsRandomEveryTime()
    {
        DeviceProof.NewNonce().Nonce.Should().NotBe(DeviceProof.NewNonce().Nonce);
    }

    [Fact]
    public void Verify_AcceptsTheSignatureOfTheMessageForThatFamilyAndChallenge()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var (nonce, _) = DeviceProof.NewNonce();
        var message = DeviceProof.Message(Family, Challenge, nonce);

        DeviceProof.Verify(PublicKeyOf(key), message, Sign(key, message)).Should().BeTrue();
    }

    [Fact]
    public void Message_HasTheExactFormatTheBrowserSigns()
    {
        Encoding.UTF8.GetString(DeviceProof.Message(Family, Challenge, "nonce_-x"))
            .Should().Be("uniover-refresh-recovery|v1|11111111111171118111111111111111|33333333333373338333333333333333|nonce_-x");
    }

    [Fact]
    public void Verify_RejectsASignatureMadeForAnotherFamily_AnotherChallengeOrAnotherNonce()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var publicKey = PublicKeyOf(key);
        var (nonce, _) = DeviceProof.NewNonce();
        var signature = Sign(key, DeviceProof.Message(Family, Challenge, nonce));

        DeviceProof.Verify(publicKey, DeviceProof.Message(OtherFamily, Challenge, nonce), signature).Should().BeFalse("outra família");
        DeviceProof.Verify(publicKey, DeviceProof.Message(Family, Guid.NewGuid(), nonce), signature).Should().BeFalse("outro desafio");
        DeviceProof.Verify(publicKey, DeviceProof.Message(Family, Challenge, DeviceProof.NewNonce().Nonce), signature).Should().BeFalse("outro nonce");
    }

    [Fact]
    public void Verify_RejectsASignatureFromAnotherKey()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var message = DeviceProof.Message(Family, Challenge, "nonce");

        DeviceProof.Verify(PublicKeyOf(key), message, Sign(other, message)).Should().BeFalse();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("não é base64url")]
    [InlineData("AAAA")]
    public void Verify_RejectsMissingOrMalformedSignatures(string? signature)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        DeviceProof.Verify(PublicKeyOf(key), DeviceProof.Message(Family, Challenge, "nonce"), signature).Should().BeFalse();
    }

    [Fact]
    public void Verify_RejectsASignatureInTheDerFormat()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var message = DeviceProof.Message(Family, Challenge, "nonce");
        var der = Base64Url.EncodeToString(key.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence));

        DeviceProof.Verify(PublicKeyOf(key), message, der).Should().BeFalse("o navegador assina em r||s (P1363)");
    }
}
