using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Identity;

/// <summary>
/// O aparelho e o "app instalado" que o app informa na entrada e na renovação, guardados na sessão para o dono ver em
/// Sessões. É informação declarada pelo cliente: um valor estranho é ignorado e nunca atrapalha a renovação.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class ClientEnvTests(PostgresFixture postgres)
{
    private const string Header = "X-UniOver-Client-Env";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Dictionary<string, string> Env(string value) => new() { [Header] = value };

    private static Guid SessionId(string access) =>
        Guid.Parse(new JsonWebTokenHandler().ReadJsonWebToken(access).GetClaim("sid").Value);

    private static async Task<(string? Platform, bool? Installed)> SessionEnvAsync(IdentityApp app, string token, Guid id)
    {
        using var response = await app.GetAsync("/api/v1/identity/sessions", token);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var session = (await IdentityApp.JsonAsync(response)).EnumerateArray().Single(s => s.GetProperty("id").GetGuid() == id);
        return (
            session.TryGetProperty("platform", out var platform) && platform.ValueKind == System.Text.Json.JsonValueKind.String ? platform.GetString() : null,
            session.TryGetProperty("installed", out var installed) && installed.ValueKind != System.Text.Json.JsonValueKind.Null ? installed.GetBoolean() : null);
    }

    private static async Task<string> LoginWithEnvAsync(IdentityApp app, string? env)
    {
        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/login", new { email = app.OwnerEmail, password = app.OwnerPassword },
            extraHeaders: env is null ? null : Env(env));
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return IdentityApp.Cookies(response).Single(c => c.Name == "uo_rt").Value;
    }

    [Fact]
    public async Task LoginWithTheHeader_RecordsTheDeviceAndTheInstalledApp_OnTheSession()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/login", new { email = app.OwnerEmail, password = app.OwnerPassword },
            extraHeaders: Env("iphone;standalone"));
        var login = await GuestSeed.ReadLoginAsync(response);

        var env = await SessionEnvAsync(app, login.AccessToken, SessionId(login.AccessToken));

        env.Should().Be(("iphone", (bool?)true));
    }

    [Theory]
    [InlineData("iphone;browser", "iphone", false)]
    [InlineData("android;standalone", "android", true)]
    [InlineData("ipad;browser", "ipad", false)]
    [InlineData("pc;browser", "pc", false)]
    [InlineData(" pc ; standalone ", "pc", true)]
    public async Task EachKnownCombination_IsRecorded(string header, string platform, bool installed)
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var secret = await LoginWithEnvAsync(app, header);
        using var refreshed = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/refresh", cookie: "uo_rt=" + secret, extraHeaders: Env(header));
        refreshed.StatusCode.Should().Be(HttpStatusCode.OK);
        var access = (await IdentityApp.JsonAsync(refreshed)).GetProperty("accessToken").GetString()!;

        (await SessionEnvAsync(app, access, SessionId(access))).Should().Be((platform, (bool?)installed));
    }

    [Fact]
    public async Task RefreshUpdatesWhatTheAppReports_SoInstallingLaterShows()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var secret = await LoginWithEnvAsync(app, "iphone;browser");
        app.Time.Advance(TimeSpan.FromMinutes(5));

        using var refreshed = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/refresh", cookie: "uo_rt=" + secret, extraHeaders: Env("iphone;standalone"));
        refreshed.StatusCode.Should().Be(HttpStatusCode.OK);
        var access = (await IdentityApp.JsonAsync(refreshed)).GetProperty("accessToken").GetString()!;

        (await SessionEnvAsync(app, access, SessionId(access))).Should().Be(("iphone", (bool?)true));
    }

    [Fact]
    public async Task OldAppWithoutTheHeader_KeepsWhatWasKnown_AndRefreshStillWorks()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var secret = await LoginWithEnvAsync(app, "iphone;standalone");
        app.Time.Advance(TimeSpan.FromMinutes(5));

        using var refreshed = await app.RefreshRawAsync(secret);
        refreshed.StatusCode.Should().Be(HttpStatusCode.OK);
        var access = (await IdentityApp.JsonAsync(refreshed)).GetProperty("accessToken").GetString()!;

        (await SessionEnvAsync(app, access, SessionId(access))).Should().Be(("iphone", (bool?)true));
    }

    [Fact]
    public async Task SessionOfAnOldApp_HasNothingRecorded()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        (await SessionEnvAsync(app, login.AccessToken, SessionId(login.AccessToken))).Should().Be(((string?)null, (bool?)null));
    }

    [Theory]
    [InlineData("lixo")]
    [InlineData("iphone")]
    [InlineData("iphone;standalone;extra")]
    [InlineData("windows;standalone")]
    [InlineData("iphone;installed")]
    [InlineData("IPHONE;standalone")]
    [InlineData(";")]
    [InlineData("<script>alert(1)</script>;browser")]
    public async Task GarbageHeader_IsIgnored_AndLoginAndRefreshStillWork(string header)
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var secret = await LoginWithEnvAsync(app, header);

        using var refreshed = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/refresh", cookie: "uo_rt=" + secret, extraHeaders: Env(header));

        refreshed.StatusCode.Should().Be(HttpStatusCode.OK);
        var access = (await IdentityApp.JsonAsync(refreshed)).GetProperty("accessToken").GetString()!;
        (await SessionEnvAsync(app, access, SessionId(access))).Should().Be(((string?)null, (bool?)null));
    }

    [Fact]
    public async Task HugeHeader_IsIgnored_AndRefreshStillWorks()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var secret = await LoginWithEnvAsync(app, null);

        using var refreshed = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/refresh", cookie: "uo_rt=" + secret, extraHeaders: Env("iphone;" + new string('x', 3000)));

        refreshed.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task TheOwnerSeesAGuestsEnvironment_AndAGuestCannotListAnotherAccount()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var (_, token) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow(), "Raphael");
        var email = GuestSeed.NewEmail();
        using var accept = await app.SendAsync(
            HttpMethod.Post, GuestSeed.AcceptRoute, new { token, email, password = GuestSeed.NewPassword() },
            extraHeaders: Env("iphone;standalone"));
        var guest = await GuestSeed.ReadLoginAsync(accept);
        Guid guestId;
        await using (var db = app.Db())
        {
            guestId = await db.Users.Where(u => u.Email == email).Select(u => u.Id).SingleAsync(Ct);
        }

        using var asOwner = await app.GetAsync($"/api/v1/identity/guests/{guestId}/sessions", owner.AccessToken);
        using var asGuest = await app.GetAsync($"/api/v1/identity/guests/{guestId}/sessions", guest.AccessToken);

        asOwner.StatusCode.Should().Be(HttpStatusCode.OK);
        var session = (await IdentityApp.JsonAsync(asOwner)).EnumerateArray().Single();
        session.GetProperty("platform").GetString().Should().Be("iphone");
        session.GetProperty("installed").GetBoolean().Should().BeTrue();
        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden, "só o dono vê as sessões de outra pessoa");
    }

    [Fact]
    public async Task TheRecoveryOfALostRefresh_RecordsTheEnvironmentOnTheNewToken()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var device = new TestDevice();
        using var login = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/login", new { email = app.OwnerEmail, password = app.OwnerPassword },
            extraHeaders: new Dictionary<string, string>(device.KeyHeaders()) { [Header] = "iphone;browser" });
        var secret = IdentityApp.Cookies(login).Single(c => c.Name == "uo_rt").Value;
        using var lost = await app.RefreshRawAsync(secret);
        lost.StatusCode.Should().Be(HttpStatusCode.OK);
        app.Time.Advance(TimeSpan.FromSeconds(30));

        var (challenge, family) = await app.ChallengeAsync(secret);
        using var recovered = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/refresh", cookie: "uo_rt=" + secret,
            extraHeaders: new Dictionary<string, string>
            {
                ["X-UniOver-Recovery-Challenge"] = challenge,
                ["X-UniOver-Recovery-Proof"] = device.Sign(family, challenge),
                [Header] = "iphone;standalone",
            });

        recovered.StatusCode.Should().Be(HttpStatusCode.OK);
        var access = (await IdentityApp.JsonAsync(recovered)).GetProperty("accessToken").GetString()!;
        (await SessionEnvAsync(app, access, SessionId(access))).Should().Be(("iphone", (bool?)true));
    }
}
