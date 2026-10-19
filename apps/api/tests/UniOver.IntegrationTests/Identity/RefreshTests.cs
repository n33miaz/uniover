using System.Globalization;
using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class RefreshTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string Seconds(TimeSpan span) => span.TotalSeconds.ToString(CultureInfo.InvariantCulture);

    [Fact]
    public async Task Refresh_RotatesTheTokenInsideTheSameFamily_AndIssuesANewJwt()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        app.Time.Advance(TimeSpan.FromMinutes(1));

        using var response = await app.RefreshRawAsync(login.RefreshSecret);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(response);
        var newAccess = body.GetProperty("accessToken").GetString()!;
        newAccess.Should().NotBe(login.AccessToken);
        body.GetProperty("expiresIn").GetInt32().Should().Be(600);

        var cookie = IdentityApp.Cookies(response).Should().ContainSingle().Which;
        cookie.Name.Should().Be("uo_rt");
        cookie.Value.Should().NotBe(login.RefreshSecret);
        cookie.Has("httponly").Should().BeTrue();
        cookie.Has("secure").Should().BeTrue();
        cookie.Get("samesite").Should().Be("strict");
        cookie.Get("path").Should().Be("/api/v1/identity/auth");
        cookie.Get("max-age").Should().Be(Seconds(TimeSpan.FromDays(14)));

        var handler = new JsonWebTokenHandler();
        handler.ReadJsonWebToken(newAccess).GetClaim("sid").Value
            .Should().Be(handler.ReadJsonWebToken(login.AccessToken).GetClaim("sid").Value, "a sessão (família) não muda ao girar");

        await using var db = app.Db();
        var tokens = await db.RefreshTokens.OrderBy(t => t.CreatedAt).ToListAsync(Ct);
        tokens.Should().HaveCount(2);
        tokens[0].UsedAt.Should().NotBeNull();
        tokens[0].ReplacedById.Should().Be(tokens[1].Id);
        tokens[1].UsedAt.Should().BeNull();
        tokens.Select(t => t.FamilyId).Distinct().Should().ContainSingle();
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.RefreshSucceeded, Ct)).Should().Be(1);

        // O token novo gira de novo normalmente.
        app.Time.Advance(TimeSpan.FromMinutes(1));
        (await app.RefreshRawAsync(cookie.Value)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Refresh_ReplayedOutsideTheTolerance_RevokesTheWholeFamily()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var rotated = await app.RefreshRawAsync(login.RefreshSecret);
        var newSecret = IdentityApp.Cookies(rotated).Single().Value;

        // Passada a tolerância de 3 s, apresentar o token antigo é sinal de cópia roubada.
        app.Time.Advance(TimeSpan.FromSeconds(4));
        using var replay = await app.RefreshRawAsync(login.RefreshSecret);

        replay.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        IdentityApp.Cookies(replay).Should().ContainSingle(c => c.Name == "uo_rt" && c.IsDeletion, "o cookie é limpo");

        // O token novo, legítimo, também deixou de valer.
        using var afterRevocation = await app.RefreshRawAsync(newSecret);
        afterRevocation.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        await using var db = app.Db();
        var tokens = await db.RefreshTokens.ToListAsync(Ct);
        tokens.Should().HaveCount(2).And.OnlyContain(t => t.RevokedAt != null && t.RevokedReason == "reuse");
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.RefreshReuseDetected, Ct)).Should().BeGreaterThanOrEqualTo(1);
    }

    [Fact]
    public async Task Refresh_ReplayedWithinThreeSeconds_Returns409WithoutRevoking()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var first = await app.RefreshRawAsync(login.RefreshSecret);
        var newSecret = IdentityApp.Cookies(first).Single().Value;

        // Duas abas giraram juntas: a segunda recebe 409 e o cliente relê o cookie novo.
        app.Time.Advance(TimeSpan.FromSeconds(2));
        using var second = await app.RefreshRawAsync(login.RefreshSecret);

        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await IdentityApp.JsonAsync(second)).GetProperty("type").GetString()
            .Should().Be("https://uniover.app/problems/refresh-conflict");
        IdentityApp.Cookies(second).Should().BeEmpty();

        await using (var db = app.Db())
        {
            (await db.RefreshTokens.CountAsync(t => t.RevokedAt != null, Ct)).Should().Be(0);
        }

        (await app.RefreshRawAsync(newSecret)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Refresh_TwoRequestsRotatingTheSameTokenAtOnce_HaveExactlyOneWinner()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        var results = await Task.WhenAll(
            Enumerable.Range(0, 4).Select(async _ =>
            {
                using var response = await app.RefreshRawAsync(login.RefreshSecret);
                return response.StatusCode;
            }));

        results.Count(s => s == HttpStatusCode.OK).Should().Be(1);
        results.Where(s => s != HttpStatusCode.OK).Should().OnlyContain(s => s == HttpStatusCode.Conflict);

        await using var db = app.Db();
        (await db.RefreshTokens.CountAsync(t => t.UsedAt == null && t.RevokedAt == null, Ct)).Should().Be(1, "um sucessor só");
    }

    [Fact]
    public async Task Refresh_WindowSlidesFor14Days_ButTheFamilyDiesAt90()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var secret = login.RefreshSecret;

        // A cada 13 dias o uso renova a janela de 14: a sessão do dono não cai enquanto ele usa o app.
        for (var day = 13; day <= 78; day += 13)
        {
            app.Time.Advance(TimeSpan.FromDays(13));
            using var response = await app.RefreshRawAsync(secret);
            response.StatusCode.Should().Be(HttpStatusCode.OK, $"dia {day}");
            var cookie = IdentityApp.Cookies(response).Single();
            secret = cookie.Value;

            if (day == 78)
            {
                // 78 + 14 passaria de 90: a validade do cookie é cortada no teto absoluto da família.
                cookie.Get("max-age").Should().Be(Seconds(TimeSpan.FromDays(12)));
            }
        }

        app.Time.Advance(TimeSpan.FromDays(13));
        using var beyondTheCeiling = await app.RefreshRawAsync(secret);
        beyondTheCeiling.StatusCode.Should().Be(HttpStatusCode.Unauthorized, "dia 91, depois do teto de 90 dias");
    }

    [Fact]
    public async Task Refresh_AfterTheSlidingWindowWithoutUse_Returns401()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        app.Time.Advance(TimeSpan.FromDays(14).Add(TimeSpan.FromSeconds(1)));
        using var response = await app.RefreshRawAsync(login.RefreshSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("lixo")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    public async Task Refresh_WithMissingOrUnknownCookie_Returns401(string? secret)
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var response = await app.RefreshRawAsync(secret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Refresh_WithoutTheClientHeader_Returns400_AndDoesNotRotate()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.RefreshRawAsync(login.RefreshSecret, clientHeader: false);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await app.RefreshRawAsync(login.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.OK, "o token segue intacto");
    }

    [Fact]
    public async Task Refresh_CookieIsNotAcceptedAsABearerCredential()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.GetAsync("/api/v1/identity/me", cookie: "uo_rt=" + login.RefreshSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
