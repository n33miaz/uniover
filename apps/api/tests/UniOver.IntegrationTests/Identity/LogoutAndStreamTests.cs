using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class LogoutAndStreamTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Logout_RevokesTheFamily_ClearsBothCookiesWithTheExactPaths_AndAudits()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        var cookies = IdentityApp.Cookies(response);
        var refresh = cookies.Should().ContainSingle(c => c.Name == "uo_rt").Which;
        var stream = cookies.Should().ContainSingle(c => c.Name == "uo_st").Which;
        refresh.IsDeletion.Should().BeTrue();
        refresh.Get("path").Should().Be("/api/v1/identity/auth");
        stream.IsDeletion.Should().BeTrue();
        stream.Get("path").Should().Be("/api/v1/");

        // A sessão acabou: o refresh antigo não gira mais.
        (await app.RefreshRawAsync(login.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        await using var db = app.Db();
        (await db.RefreshTokens.SingleAsync(Ct)).RevokedReason.Should().Be("logout");
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.Logout, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Logout_WithoutAToken_Returns401_AndWithoutTheCookieStillCannotBeUsed()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var anonymous = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout");
        using var withCookieOnly = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/logout", cookie: "uo_rt=" + login.RefreshSecret);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        withCookieOnly.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await app.RefreshRawAsync(login.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.OK, "nada foi revogado");
    }

    [Fact]
    public async Task Logout_OfOneSession_DoesNotTouchAnotherSession()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var phone = await app.LoginAsync();
        var laptop = await app.LoginAsync();

        (await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: phone.AccessToken)).Dispose();

        (await app.RefreshRawAsync(phone.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await app.RefreshRawAsync(laptop.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task StreamTicket_SetsAShortLivedCookieWithTheStreamAudience()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var cookie = IdentityApp.Cookies(response).Should().ContainSingle().Which;
        cookie.Name.Should().Be("uo_st");
        cookie.Has("httponly").Should().BeTrue();
        cookie.Has("secure").Should().BeTrue();
        cookie.Get("samesite").Should().Be("strict");
        cookie.Get("path").Should().Be("/api/v1/");
        cookie.Get("max-age").Should().Be("120");

        var handler = new JsonWebTokenHandler();
        var ticket = handler.ReadJsonWebToken(cookie.Value);
        ticket.Audiences.Should().Equal("uniover-stream");
        ticket.Issuer.Should().Be("uniover");
        (ticket.ValidTo - ticket.ValidFrom).Should().Be(TimeSpan.FromSeconds(120));
        ticket.GetClaim("sub").Value.Should().Be(handler.ReadJsonWebToken(login.AccessToken).GetClaim("sub").Value);
        ticket.GetClaim("sid").Value.Should().Be(handler.ReadJsonWebToken(login.AccessToken).GetClaim("sid").Value);

        // O ticket vai só no cookie: nada de token na URL nem no corpo.
        (await response.Content.ReadAsStringAsync(Ct)).Should().NotContain(cookie.Value);
        response.Headers.Location.Should().BeNull();
    }

    [Fact]
    public async Task StreamTicket_RequiresTheJwtInTheHeader_NeverTheUrl()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var anonymous = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket");
        using var inQuery = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/stream-ticket?access_token=" + login.AccessToken);
        using var withRefreshCookie = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", cookie: "uo_rt=" + login.RefreshSecret);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        inQuery.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        withRefreshCookie.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task StreamTicket_AfterLogout_IsRefused()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        (await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: login.AccessToken)).Dispose();

        // O JWT de acesso ainda vale por minutos, mas a sessão acabou: não pode abrir stream.
        using var response = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task StreamAccess_AcceptsOnlyTheStreamCookie_OnlyOnGet()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var ticketResponse = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: login.AccessToken);
        var ticket = IdentityApp.Cookies(ticketResponse).Single().Value;

        using var withTicket = await app.GetAsync("/api/test/stream", cookie: "uo_st=" + ticket);
        using var postWithTicket = await app.SendAsync(HttpMethod.Post, "/api/test/stream", cookie: "uo_st=" + ticket);

        withTicket.StatusCode.Should().Be(HttpStatusCode.OK);
        postWithTicket.StatusCode.Should().NotBe(HttpStatusCode.OK, "o bilhete não serve para escrever");
        ((int)postWithTicket.StatusCode).Should().BeOneOf(401, 403);
    }

    [Fact]
    public async Task StreamAccess_RejectsTheRefreshCookieAndTheAccessJwt()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var refreshCookie = await app.GetAsync("/api/test/stream", cookie: "uo_rt=" + login.RefreshSecret);
        using var accessHeader = await app.GetAsync("/api/test/stream", bearer: login.AccessToken);
        using var accessAsTicket = await app.GetAsync("/api/test/stream", cookie: "uo_st=" + login.AccessToken);
        using var nothing = await app.GetAsync("/api/test/stream");

        refreshCookie.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        accessHeader.StatusCode.Should().Be(HttpStatusCode.Unauthorized, "o JWT de acesso não autentica o stream");
        accessAsTicket.StatusCode.Should().Be(HttpStatusCode.Unauthorized, "público errado");
        nothing.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task StreamCookie_DoesNotAuthenticateAnyRouteOutsideStreamAccess()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var ticketResponse = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: login.AccessToken);
        var ticket = IdentityApp.Cookies(ticketResponse).Single().Value;

        foreach (var url in new[] { "/api/v1/identity/me", "/api/test/protected", "/api/test/default" })
        {
            using var response = await app.GetAsync(url, cookie: "uo_st=" + ticket);
            response.StatusCode.Should().Be(HttpStatusCode.Unauthorized, url);
        }

        using var logout = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", cookie: "uo_st=" + ticket);
        logout.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task StreamTicket_ExpiresAfter120Seconds()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var ticketResponse = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: login.AccessToken);
        var ticket = IdentityApp.Cookies(ticketResponse).Single().Value;

        app.Time.Advance(TimeSpan.FromSeconds(100));
        (await app.GetAsync("/api/test/stream", cookie: "uo_st=" + ticket)).StatusCode.Should().Be(HttpStatusCode.OK);

        // 120 s de validade mais 30 s de tolerância de relógio.
        app.Time.Advance(TimeSpan.FromSeconds(60));
        (await app.GetAsync("/api/test/stream", cookie: "uo_st=" + ticket)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
