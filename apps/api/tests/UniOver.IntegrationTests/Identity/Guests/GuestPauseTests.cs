using System.Net;
using System.Net.Http.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Tv;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity.Guests;

/// <summary>
/// Pausar um convidado é reversível: a conta e as permissões ficam, mas entrar, renovar e agir param até o dono retomar.
/// Só o dono pausa, e cada pausa e retomada fica na auditoria.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class GuestPauseTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string PauseRoute(Guid id) => $"/api/v1/identity/guests/{id}/pause";

    private static string ResumeRoute(Guid id) => $"/api/v1/identity/guests/{id}/resume";

    private static async Task<HttpResponseMessage> LoginAsync(TvApp app, string email, string password)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/login")
        {
            Content = JsonContent.Create(new { email, password }),
        };
        request.Headers.Add(IdentityApp.ClientHeader, "web");
        return await app.Client.SendAsync(request, Ct);
    }

    private static async Task<HttpResponseMessage> RefreshAsync(TvApp app, string secret)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/refresh");
        request.Headers.Add(IdentityApp.ClientHeader, "web");
        request.Headers.Add("Cookie", "uo_rt=" + secret);
        return await app.Client.SendAsync(request, Ct);
    }

    [Fact]
    public async Task PausedGuest_LosesLoginRefreshAndTheTv_AndTheOwnerIsUntouched()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var pause = await app.SendAsync(HttpMethod.Post, PauseRoute(guest.UserId));
        using var login = await LoginAsync(app, guest.Email, guest.Password);
        using var refresh = await RefreshAsync(app, guest.Login.RefreshSecret);
        using var state = await app.GetAsync("/api/v1/tv/state", bearer: guest.Login.AccessToken);
        using var key = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/keys", new { key = "HOME" }, bearer: guest.Login.AccessToken);
        using var owner = await app.GetAsync("/api/v1/tv/state");

        pause.StatusCode.Should().Be(HttpStatusCode.NoContent);
        login.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await IdentityApp.JsonAsync(login)).GetProperty("type").GetString().Should().EndWith("/guest-paused");
        refresh.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await IdentityApp.JsonAsync(refresh)).GetProperty("type").GetString().Should().EndWith("/guest-paused");
        state.StatusCode.Should().Be(HttpStatusCode.Forbidden, "o JWT curto segue válido, mas a conta está pausada");
        key.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        owner.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = IdentityApp.CreateContext(app.Database.OwnerConnection);
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.RefreshReuseDetected, Ct))
            .Should().Be(0, "a sessão derrubada pela pausa não é reuso de token");
        (await db.RefreshTokens.Where(t => t.UserId == guest.UserId).ToListAsync(Ct))
            .Should().OnlyContain(t => t.RevokedAt != null && t.RevokedReason == RevokeReasons.GuestPaused);
        (await db.Users.SingleAsync(u => u.Id == guest.UserId, Ct)).DisabledAt.Should().BeNull("pausar não revoga");
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.GuestPaused, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ResumedGuest_EntersAgain_WithTheSamePermissions()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var pause = await app.SendAsync(HttpMethod.Post, PauseRoute(guest.UserId));

        using var resume = await app.SendAsync(HttpMethod.Post, ResumeRoute(guest.UserId));
        using var login = await LoginAsync(app, guest.Email, guest.Password);
        var again = await GuestSeed.ReadLoginAsync(login);
        using var state = await app.GetAsync("/api/v1/tv/state", bearer: again.AccessToken);

        using var oldSession = await RefreshAsync(app, guest.Login.RefreshSecret);

        pause.StatusCode.Should().Be(HttpStatusCode.NoContent);
        resume.StatusCode.Should().Be(HttpStatusCode.NoContent);
        state.StatusCode.Should().Be(HttpStatusCode.OK);
        oldSession.StatusCode.Should().Be(HttpStatusCode.Unauthorized, "a sessão derrubada na pausa não volta com a retomada");
        (await IdentityApp.JsonAsync(oldSession)).GetProperty("type").GetString().Should().NotEndWith("/guest-paused");
        await using var db = IdentityApp.CreateContext(app.Database.OwnerConnection);
        (await db.Users.SingleAsync(u => u.Id == guest.UserId, Ct)).PausedAt.Should().BeNull();
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.GuestResumed, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Pause_IsIdempotent_AndAuditedOnce()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var first = await app.SendAsync(HttpMethod.Post, PauseRoute(guest.UserId));
        using var second = await app.SendAsync(HttpMethod.Post, PauseRoute(guest.UserId));

        first.StatusCode.Should().Be(HttpStatusCode.NoContent);
        second.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = IdentityApp.CreateContext(app.Database.OwnerConnection);
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.GuestPaused, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task OnlyTheOwnerCanPauseOrResume_AndNeverTheOwnerAccount()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var other = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Bia");
        Guid ownerId;
        await using (var db = IdentityApp.CreateContext(app.Database.OwnerConnection))
        {
            ownerId = (await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, Ct)).Id;
        }

        using var byGuest = await app.SendAsync(HttpMethod.Post, PauseRoute(other.UserId), bearer: guest.Login.AccessToken);
        using var owner = await app.SendAsync(HttpMethod.Post, PauseRoute(ownerId));
        using var missing = await app.SendAsync(HttpMethod.Post, PauseRoute(Guid.NewGuid()));

        byGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        owner.StatusCode.Should().Be(HttpStatusCode.NotFound, "o dono não se pausa");
        missing.StatusCode.Should().Be(HttpStatusCode.NotFound);
        await using var check = IdentityApp.CreateContext(app.Database.OwnerConnection);
        (await check.Users.SingleAsync(u => u.Id == other.UserId, Ct)).PausedAt.Should().BeNull();
    }

    [Fact]
    public async Task RevokedGuest_CannotBePausedOrResumed()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke");

        using var pause = await app.SendAsync(HttpMethod.Post, PauseRoute(guest.UserId));
        using var resume = await app.SendAsync(HttpMethod.Post, ResumeRoute(guest.UserId));

        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        pause.StatusCode.Should().Be(HttpStatusCode.Conflict);
        resume.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task ListGuests_ShowsThePause()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var pause = await app.SendAsync(HttpMethod.Post, PauseRoute(guest.UserId));

        using var list = await app.GetAsync("/api/v1/identity/guests");

        pause.StatusCode.Should().Be(HttpStatusCode.NoContent);
        var body = await IdentityApp.JsonAsync(list);
        body.EnumerateArray().Single(g => g.GetProperty("id").GetGuid() == guest.UserId)
            .GetProperty("pausedAt").ValueKind.Should().Be(System.Text.Json.JsonValueKind.String);
    }
}
