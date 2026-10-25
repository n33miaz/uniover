using AwesomeAssertions;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Domain;

public class QrLoginRequestTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 24, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Validity = TimeSpan.FromSeconds(120);

    private static QrLoginRequest NewRequest() =>
        QrLoginRequest.Create(QrLoginCodes.NewCode().Hash, SecretTokens.Generate().Hash, "203.0.113.7", "navegador/1.0", Now, Validity);

    [Fact]
    public void Create_StartsPending_AndExpiresAfterTheValidity()
    {
        var request = NewRequest();

        request.Evaluate(Now).Should().Be(QrLoginState.Pending);
        request.Evaluate(Now.AddSeconds(119)).Should().Be(QrLoginState.Pending);
        request.ExpiresAt.Should().Be(Now.AddSeconds(120));
        request.IsOpenAt(Now).Should().BeTrue();
    }

    [Fact]
    public void Evaluate_ExactlyAtExpiry_IsAlreadyExpired()
    {
        var request = NewRequest();

        request.Evaluate(request.ExpiresAt).Should().Be(QrLoginState.Expired);
        request.IsOpenAt(request.ExpiresAt).Should().BeFalse();
        request.IsOpenAt(request.ExpiresAt.AddSeconds(-1)).Should().BeTrue();
    }

    [Fact]
    public void Create_TruncatesWhatTheAnonymousClientSent()
    {
        var request = QrLoginRequest.Create(
            QrLoginCodes.NewCode().Hash, SecretTokens.Generate().Hash, new string('1', 500), new string('a', 5000), Now, Validity);

        request.RequesterIp.Should().HaveLength(AuditText.IpMax);
        request.RequesterUserAgent.Should().HaveLength(AuditText.UserAgentMax);
    }

    [Fact]
    public void Create_RejectsAValidityThatIsNotPositive()
    {
        var act = () => QrLoginRequest.Create(
            QrLoginCodes.NewCode().Hash, SecretTokens.Generate().Hash, null, null, Now, TimeSpan.Zero);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}

public class QrLoginCodesTests
{
    [Fact]
    public void NewCode_IsShortUrlSafeAndDifferentEveryTime()
    {
        var codes = Enumerable.Range(0, 50).Select(_ => QrLoginCodes.NewCode().Code).ToList();

        codes.Should().OnlyHaveUniqueItems();
        codes.Should().OnlyContain(c => c.Length == QrLoginCodes.CodeLength && c.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '-' || ch == '_'));
    }

    [Fact]
    public void Hash_OfTheIssuedCode_MatchesTheStoredHash_AndTheCodeIsNotTheHash()
    {
        var (code, hash) = QrLoginCodes.NewCode();

        QrLoginCodes.Hash(code).Should().Equal(hash);
        hash.Should().HaveCount(32);
        Convert.ToBase64String(hash).Should().NotContain(code);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("curto")]
    [InlineData("AAAAAAAAAAAAAAAAA")]
    [InlineData("AAAAAAAAAAAAAAA ")]
    [InlineData("AAAAAAAAAAAAAAA+")]
    [InlineData("AAAAAAAAAAAAAAA/")]
    public void Hash_RejectsATextThatIsNotShapedLikeOurCode(string? code)
    {
        QrLoginCodes.Hash(code).Should().BeNull();
    }
}
