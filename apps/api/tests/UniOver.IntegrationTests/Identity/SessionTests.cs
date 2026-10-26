using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class SessionTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static Guid SessionId(string access) =>
        Guid.Parse(new JsonWebTokenHandler().ReadJsonWebToken(access).GetClaim("sid").Value);

    [Fact]
    public async Task OwnerSeesOnlyOwnActiveSessions_AndTheCurrentOne()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var first = await app.LoginAsync();
        var second = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        app.Time.Advance(TimeSpan.FromMinutes(1));
        using var refresh = await app.RefreshRawAsync(first.RefreshSecret);
        refresh.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.GetAsync("/api/v1/identity/sessions", bearer: second.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var sessions = await IdentityApp.JsonAsync(response);
        sessions.GetArrayLength().Should().Be(2);
        sessions.EnumerateArray().Select(item => item.GetProperty("id").GetGuid())
            .Should().BeEquivalentTo([SessionId(first.AccessToken), SessionId(second.AccessToken)]);
        sessions.EnumerateArray().Single(item => item.GetProperty("isCurrent").GetBoolean())
            .GetProperty("id").GetGuid().Should().Be(SessionId(second.AccessToken));
        sessions.EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == SessionId(first.AccessToken))
            .GetProperty("lastUsedAt").GetDateTimeOffset().Should().Be(app.Time.GetUtcNow());

        using var guestList = await app.GetAsync("/api/v1/identity/sessions", bearer: guest.Login.AccessToken);
        (await IdentityApp.JsonAsync(guestList)).GetArrayLength().Should().Be(1);
    }

    [Fact]
    public async Task ListMasksTheStoredIp_AndKeepsTheKnownUserAgentAfterRefresh()
    {
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { ForwardedHeaders = true });
        using var loginResponse = await app.LoginRawAsync(
            app.OwnerEmail, app.OwnerPassword, "203.0.113.27", "Mozilla/5.0 (Windows) Chrome/120");
        var loginBody = await IdentityApp.JsonAsync(loginResponse);
        var access = loginBody.GetProperty("accessToken").GetString()!;
        var secret = IdentityApp.Cookies(loginResponse).Single(c => c.Name == "uo_rt").Value;
        using var rotated = await app.RefreshRawAsync(secret);
        rotated.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.GetAsync("/api/v1/identity/sessions", bearer: access);
        var session = (await IdentityApp.JsonAsync(response)).EnumerateArray().Single();
        session.GetProperty("ip").GetString().Should().Be("203.0.113.0/24");
        session.GetProperty("userAgent").GetString().Should().Contain("Chrome/120");
    }

    [Fact]
    public async Task RevokingOneFamilyStopsItsRefresh_AndRepeatingIsHarmless()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var first = await app.LoginAsync();
        var second = await app.LoginAsync();
        var id = SessionId(first.AccessToken);

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/sessions/{id}/revoke", bearer: second.AccessToken);
        using var repeat = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/sessions/{id}/revoke", bearer: second.AccessToken);
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        repeat.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await app.RefreshRawAsync(first.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await app.RefreshRawAsync(second.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.OK);

        await using var db = app.Db();
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.SessionRevoked, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task RevokeOthersKeepsTheCurrentRefresh_AndCurrentRevocationDeletesCookies()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var other = await app.LoginAsync();
        var current = await app.LoginAsync();

        using var revokeOthers = await app.SendAsync(HttpMethod.Post,
            "/api/v1/identity/sessions/others/revoke", bearer: current.AccessToken);
        revokeOthers.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await app.RefreshRawAsync(other.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        using var currentRefresh = await app.RefreshRawAsync(current.RefreshSecret);
        currentRefresh.StatusCode.Should().Be(HttpStatusCode.OK);
        var currentSecret = IdentityApp.Cookies(currentRefresh).Single(c => c.Name == "uo_rt").Value;

        using var endCurrent = await app.SendAsync(HttpMethod.Post,
            $"/api/v1/identity/sessions/{SessionId(current.AccessToken)}/revoke", bearer: current.AccessToken);
        endCurrent.StatusCode.Should().Be(HttpStatusCode.NoContent);
        IdentityApp.Cookies(endCurrent).Should().Contain(c => c.Name == "uo_rt" && c.IsDeletion);
        (await app.RefreshRawAsync(currentSecret)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task GuestCannotReadOrRevokeAnotherAccount_ButOwnerCanRevokeGuestWithAudit()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var other = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var otherId = SessionId(other.Login.AccessToken);

        using var guestList = await app.GetAsync($"/api/v1/identity/guests/{other.UserId}/sessions", bearer: guest.Login.AccessToken);
        using var guestRevoke = await app.SendAsync(HttpMethod.Post,
            $"/api/v1/identity/guests/{other.UserId}/sessions/{otherId}/revoke", bearer: guest.Login.AccessToken);
        using var wrongOwnRevoke = await app.SendAsync(HttpMethod.Post,
            $"/api/v1/identity/sessions/{otherId}/revoke", bearer: guest.Login.AccessToken);
        guestList.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        guestRevoke.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        wrongOwnRevoke.StatusCode.Should().Be(HttpStatusCode.NotFound);

        using var ownerList = await app.GetAsync($"/api/v1/identity/guests/{other.UserId}/sessions", bearer: owner.AccessToken);
        (await IdentityApp.JsonAsync(ownerList)).GetArrayLength().Should().Be(1);
        using var ownerRevoke = await app.SendAsync(HttpMethod.Post,
            $"/api/v1/identity/guests/{other.UserId}/sessions/{otherId}/revoke", bearer: owner.AccessToken);
        ownerRevoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await app.RefreshRawAsync(other.Login.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        await using var db = app.Db();
        var audit = await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.SessionRevoked, Ct);
        audit.Detail.Should().Be($"{other.UserId:N}|{otherId:N}");
        audit.UserId.Should().Be(SessionOwnerId(db, owner.AccessToken));
    }

    private static Guid SessionOwnerId(UniOver.Modules.Identity.Persistence.IdentityDbContext db, string access) =>
        db.RefreshTokens.Single(t => t.FamilyId == SessionId(access)).UserId;
}
