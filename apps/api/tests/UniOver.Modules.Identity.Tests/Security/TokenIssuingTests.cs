using System.Security.Cryptography;
using AwesomeAssertions;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Security;

public class TokenIssuingTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);

    private sealed class FakeEnvironment(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;

        public string ApplicationName { get; set; } = "teste";

        public string ContentRootPath { get; set; } = string.Empty;

        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private static string NewKey() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    private static JwtKeySet Keys(string? current, string? previous = null) =>
        JwtKeySet.Create(new JwtKeyOptions { SigningKey = current, PreviousSigningKey = previous }, NullLogger.Instance);

    [Fact]
    public void Issue_SignsWithHs256_AndCarriesTheAgreedClaims()
    {
        var key = NewKey();
        var issuer = new AccessTokenIssuer(Keys(key), new FakeEnvironment(Environments.Production));
        var user = Guid.NewGuid();
        var session = Guid.NewGuid();

        var token = issuer.Issue(user, session, AccountRoles.Guest, UniOverAuth.ApiAudience, TimeSpan.FromMinutes(10), Now);

        var jwt = new JsonWebTokenHandler().ReadJsonWebToken(token.Value);
        jwt.Alg.Should().Be("HS256");
        jwt.Issuer.Should().Be("uniover");
        jwt.Audiences.Should().Equal("uniover-api");
        jwt.GetClaim("sub").Value.Should().Be(user.ToString());
        jwt.GetClaim("sid").Value.Should().Be(session.ToString());
        jwt.GetClaim("role").Value.Should().Be("guest");
        jwt.GetClaim("jti").Value.Should().NotBeNullOrEmpty();
        jwt.ValidFrom.Should().Be(Now.UtcDateTime);
        jwt.ValidTo.Should().Be(Now.AddMinutes(10).UtcDateTime);
        token.ExpiresAt.Should().Be(Now.AddMinutes(10));
    }

    [Theory]
    [InlineData("")]
    [InlineData("admin")]
    [InlineData("Owner")]
    public void Issue_WithAnUnknownRole_IsRefused(string role)
    {
        var issuer = new AccessTokenIssuer(Keys(NewKey()), new FakeEnvironment(Environments.Production));

        var act = () => issuer.Issue(Guid.NewGuid(), Guid.NewGuid(), role, UniOverAuth.ApiAudience, TimeSpan.FromMinutes(1), Now);

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Issue_EachTokenHasItsOwnJti()
    {
        var issuer = new AccessTokenIssuer(Keys(NewKey()), new FakeEnvironment(Environments.Production));
        var handler = new JsonWebTokenHandler();

        var first = handler.ReadJsonWebToken(issuer.Issue(Guid.NewGuid(), Guid.NewGuid(), AccountRoles.Owner, "a", TimeSpan.FromMinutes(1), Now).Value);
        var second = handler.ReadJsonWebToken(issuer.Issue(Guid.NewGuid(), Guid.NewGuid(), AccountRoles.Owner, "a", TimeSpan.FromMinutes(1), Now).Value);

        first.GetClaim("jti").Value.Should().NotBe(second.GetClaim("jti").Value);
    }

    [Fact]
    public async Task Issue_TheTokenValidatesWithTheSameKeyAndNotWithAnother()
    {
        var key = NewKey();
        var issuer = new AccessTokenIssuer(Keys(key), new FakeEnvironment(Environments.Production));
        var token = issuer.Issue(Guid.NewGuid(), Guid.NewGuid(), AccountRoles.Owner, UniOverAuth.ApiAudience, TimeSpan.FromMinutes(10), DateTimeOffset.UtcNow).Value;

        TokenValidationParameters For(string base64) => new()
        {
            ValidIssuer = UniOverAuth.Issuer,
            ValidAudience = UniOverAuth.ApiAudience,
            IssuerSigningKey = new SymmetricSecurityKey(Convert.FromBase64String(base64)),
        };

        var ok = await new JsonWebTokenHandler().ValidateTokenAsync(token, For(key));
        var wrong = await new JsonWebTokenHandler().ValidateTokenAsync(token, For(NewKey()));

        ok.IsValid.Should().BeTrue();
        wrong.IsValid.Should().BeFalse();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("não-é-base64")]
    [InlineData("AAAA")]
    public void KeySet_WithAMissingOrInvalidKey_FallsBackToATemporaryKey_InsteadOfThrowing(string? configured)
    {
        var keys = Keys(configured);

        keys.IsEphemeral.Should().BeTrue();
        keys.ValidationKeys.Should().ContainSingle();
    }

    [Fact]
    public void KeySet_WithAValidKey_IsNotTemporary_AndKeepsThePreviousKeyForValidationOnly()
    {
        var current = NewKey();
        var previous = NewKey();

        var keys = Keys(current, previous);

        keys.IsEphemeral.Should().BeFalse();
        keys.ValidationKeys.Should().HaveCount(2);
        keys.ValidationKeys.Select(k => k.KeyId).Should().OnlyHaveUniqueItems().And.NotContainNulls();
        keys.SigningCredentials.Key.KeyId.Should().Be(keys.ValidationKeys[0].KeyId, "assina com a atual");
    }

    [Fact]
    public void KeySet_IgnoresAnInvalidPreviousKey()
    {
        Keys(NewKey(), "lixo").ValidationKeys.Should().ContainSingle();
    }

    [Fact]
    public void Issue_WithATemporaryKey_IsRefusedOutsideDevelopmentAndTesting()
    {
        var keys = Keys(null);

        var production = new AccessTokenIssuer(keys, new FakeEnvironment(Environments.Production));
        var development = new AccessTokenIssuer(keys, new FakeEnvironment(Environments.Development));
        var testing = new AccessTokenIssuer(keys, new FakeEnvironment("Testing"));

        var act = () => production.Issue(Guid.NewGuid(), Guid.NewGuid(), AccountRoles.Owner, "a", TimeSpan.FromMinutes(1), Now);

        act.Should().Throw<InvalidOperationException>().WithMessage("*SigningKey*");
        development.Issue(Guid.NewGuid(), Guid.NewGuid(), AccountRoles.Owner, "a", TimeSpan.FromMinutes(1), Now).Value.Should().NotBeNullOrEmpty();
        testing.Issue(Guid.NewGuid(), Guid.NewGuid(), AccountRoles.Owner, "a", TimeSpan.FromMinutes(1), Now).Value.Should().NotBeNullOrEmpty();
    }
}

public class IdentityOptionsTests
{
    [Fact]
    public void Defaults_AreTheOnesTheOwnerApproved()
    {
        var options = new IdentityModuleOptions();

        options.AccessLifetime.Should().Be(TimeSpan.FromMinutes(10));
        options.Refresh.SlidingWindow.Should().Be(TimeSpan.FromDays(14));
        options.Refresh.AbsoluteLifetime.Should().Be(TimeSpan.FromDays(90));
        options.Refresh.ReuseGrace.Should().Be(TimeSpan.FromSeconds(3));
        options.Refresh.RecoveryWindow.Should().Be(TimeSpan.FromMinutes(10));
        options.Refresh.ChallengeLifetime.Should().Be(TimeSpan.FromMinutes(2));
        options.Lockout.Threshold.Should().Be(5);
        options.Lockout.MaxDelay.Should().Be(TimeSpan.FromMinutes(15));
        options.MinPasswordLength.Should().Be(10);
        options.StreamTicketLifetime.Should().Be(TimeSpan.FromSeconds(120));
        options.GuestInviteLifetime.Should().Be(TimeSpan.FromDays(7));
        options.MaxPendingGuestInvites.Should().Be(10);
        options.GuestStatusCacheLifetime.Should().Be(TimeSpan.FromSeconds(30));
        options.Cookies.SecureOverride.Should().BeNull();
        IdentityModuleOptions.IsValid(options).Should().BeTrue();
    }

    [Theory]
    [InlineData(0, 14, 90)]
    [InlineData(10, 0, 90)]
    [InlineData(10, 14, 7)]
    [InlineData(61, 14, 90)]
    public void IsValid_RejectsValuesThatWouldBreakTheRules(int accessMinutes, int slidingDays, int absoluteDays)
    {
        var options = new IdentityModuleOptions
        {
            AccessMinutes = accessMinutes,
            RefreshSlidingDays = slidingDays,
            RefreshAbsoluteDays = absoluteDays,
        };

        IdentityModuleOptions.IsValid(options).Should().BeFalse();
    }

    [Theory]
    [InlineData(0, 10)]
    [InlineData(721, 10)]
    [InlineData(48, 0)]
    public void IsValid_RejectsGuestInviteValuesThatWouldBreakTheRules(int hours, int maxPending)
    {
        var options = new IdentityModuleOptions { GuestInviteHours = hours, MaxPendingGuestInvites = maxPending };

        IdentityModuleOptions.IsValid(options).Should().BeFalse();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(601)]
    public void IsValid_RejectsAGuestStatusCacheOutsideOneSecondToTenMinutes(int seconds)
    {
        IdentityModuleOptions.IsValid(new IdentityModuleOptions { GuestStatusCacheSeconds = seconds }).Should().BeFalse();
    }

    [Theory]
    [InlineData(-1, 120)]
    [InlineData(3601, 120)]
    [InlineData(600, 9)]
    [InlineData(600, 601)]
    public void IsValid_RejectsARecoveryWindowOrChallengeOutsideTheirBounds(int recoverySeconds, int challengeSeconds)
    {
        var options = new IdentityModuleOptions { RefreshRecoverySeconds = recoverySeconds, RefreshChallengeSeconds = challengeSeconds };

        IdentityModuleOptions.IsValid(options).Should().BeFalse();
    }

    [Fact]
    public void IsValid_AcceptsTurningTheRecoveryOff()
    {
        IdentityModuleOptions.IsValid(new IdentityModuleOptions { RefreshRecoverySeconds = 0 }).Should().BeTrue();
    }
}
