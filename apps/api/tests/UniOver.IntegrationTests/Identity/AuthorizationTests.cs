using System.Net;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class AuthorizationTests(PostgresFixture postgres)
{
    [Theory]
    [InlineData("/health/live")]
    [InlineData("/api/v1/identity/info")]
    [InlineData("/api/v1/tv/info")]
    [InlineData("/")]
    [InlineData("/openapi/v1.json")]
    public async Task PublicRoutes_StayAnonymous(string url)
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var response = await app.GetAsync(url);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("/api/v1/identity/me")]
    [InlineData("/api/test/protected")]
    [InlineData("/api/test/default")]
    public async Task EveryOtherRoute_WithoutAToken_Returns401AsProblemJson(string url)
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var response = await app.GetAsync(url);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/problem+json");
    }

    [Fact]
    public async Task ARouteWithNoAuthorizationMetadata_IsStillProtected_ByTheDefaultPolicy()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var anonymous = await app.GetAsync("/api/test/default");
        using var authenticated = await app.GetAsync("/api/test/default", bearer: login.AccessToken);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        authenticated.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Me_WithAValidJwt_ReturnsTheOwnerProfile()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.GetAsync("/api/v1/identity/me", bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(response);
        body.GetProperty("email").GetString().Should().Be("dono@uniover.test");
        body.GetProperty("displayName").GetString().Should().Be("dono");
        body.GetProperty("id").GetGuid().Should().NotBeEmpty();
        body.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(["id", "email", "displayName", "role"], "nada de hash nem contador");
    }

    [Fact]
    public async Task AccessToken_InTheQueryString_IsIgnored()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.GetAsync("/api/v1/identity/me?access_token=" + login.AccessToken);
        using var protectedRoute = await app.GetAsync("/api/test/protected?access_token=" + login.AccessToken + "&token=" + login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        protectedRoute.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task AccessToken_ExpiresAfterTenMinutesPlusSkew()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        app.Time.Advance(TimeSpan.FromMinutes(10));
        (await app.GetAsync("/api/v1/identity/me", bearer: login.AccessToken)).StatusCode
            .Should().Be(HttpStatusCode.OK, "ainda dentro dos 30 s de tolerância de relógio");

        app.Time.Advance(TimeSpan.FromSeconds(31));
        (await app.GetAsync("/api/v1/identity/me", bearer: login.AccessToken)).StatusCode
            .Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task AnAlreadyExpiredJwt_SignedWithTheRightKey_Returns401()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        var expired = IdentityApp.CraftToken(app.SigningKey, now.AddMinutes(-30), now.AddMinutes(-20));
        var valid = IdentityApp.CraftToken(app.SigningKey, now.AddMinutes(-1), now.AddMinutes(5));

        (await app.GetAsync("/api/test/protected", bearer: expired)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await app.GetAsync("/api/test/protected", bearer: valid)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Jwt_WithWrongKeyAudienceIssuerOrAlgorithm_IsRejected()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        var otherKey = IdentityApp.NewKey();

        var tokens = new Dictionary<string, string>
        {
            ["chave errada"] = IdentityApp.CraftToken(otherKey, now.AddMinutes(-1), now.AddMinutes(5)),
            ["público de stream"] = IdentityApp.CraftToken(app.SigningKey, now.AddMinutes(-1), now.AddMinutes(5), audience: "uniover-stream"),
            ["público qualquer"] = IdentityApp.CraftToken(app.SigningKey, now.AddMinutes(-1), now.AddMinutes(5), audience: "outro"),
            ["emissor errado"] = IdentityApp.CraftToken(app.SigningKey, now.AddMinutes(-1), now.AddMinutes(5), issuer: "outro"),
            ["alg none"] = UnsignedToken(now),
            ["lixo"] = "isto.nao.e-um-jwt",
        };

        foreach (var (reason, token) in tokens)
        {
            (await app.GetAsync("/api/test/protected", bearer: token)).StatusCode
                .Should().Be(HttpStatusCode.Unauthorized, reason);
        }
    }

    // Token sem assinatura ("alg": "none") com claims e validade corretas: o validador só aceita HS256 assinado.
    private static string UnsignedToken(DateTimeOffset now)
    {
        static string B64(string json) => Microsoft.IdentityModel.Tokens.Base64UrlEncoder.Encode(json);
        var header = B64("{\"alg\":\"none\",\"typ\":\"JWT\"}");
        var payload = B64(
            $"{{\"iss\":\"uniover\",\"aud\":\"uniover-api\",\"sub\":\"{Guid.NewGuid()}\",\"sid\":\"{Guid.NewGuid()}\","
            + $"\"nbf\":{now.AddMinutes(-1).ToUnixTimeSeconds()},\"exp\":{now.AddMinutes(5).ToUnixTimeSeconds()}}}");
        return $"{header}.{payload}.";
    }

    [Fact]
    public async Task Jwt_SignedWithThePreviousKey_StillValidates_DuringAKeyRotation()
    {
        var previous = IdentityApp.NewKey();
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { PreviousSigningKey = previous });
        var now = app.Time.GetUtcNow();

        var withPrevious = IdentityApp.CraftToken(previous, now.AddMinutes(-1), now.AddMinutes(5));
        var withUnknown = IdentityApp.CraftToken(IdentityApp.NewKey(), now.AddMinutes(-1), now.AddMinutes(5));

        (await app.GetAsync("/api/test/protected", bearer: withPrevious)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await app.GetAsync("/api/test/protected", bearer: withUnknown)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // Tokens novos saem com a chave atual, não com a anterior.
        var login = await app.LoginAsync();
        (await app.GetAsync("/api/test/protected", bearer: login.AccessToken)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task JwtOfADeletedAccount_CannotReadTheProfile()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        var orphan = IdentityApp.CraftToken(app.SigningKey, now.AddMinutes(-1), now.AddMinutes(5), subject: Guid.NewGuid());

        using var response = await app.GetAsync("/api/v1/identity/me", bearer: orphan);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task WithoutASigningKey_TheHostStillStarts_AndDevelopmentIssuesTokensWithATemporaryKey()
    {
        var extra = new Dictionary<string, string?> { ["Modules:Identity:Jwt:SigningKey"] = string.Empty };
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { Extra = extra });

        (await app.GetAsync("/health/live")).StatusCode.Should().Be(HttpStatusCode.OK);
        app.Logs.Lines.Should().Contain(l => l.Contains("Chave de assinatura do JWT ausente", StringComparison.Ordinal));
        var login = await app.LoginAsync();
        (await app.GetAsync("/api/v1/identity/me", bearer: login.AccessToken)).StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
