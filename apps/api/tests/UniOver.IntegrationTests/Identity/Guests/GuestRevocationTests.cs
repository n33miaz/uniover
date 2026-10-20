using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Tv;

namespace UniOver.IntegrationTests.Identity.Guests;

/// <summary>
/// Revogar um convidado vale na TV já, e não só quando o JWT curto vence: a política da TV confere a conta (com cache
/// de 30 s) e o fluxo ao vivo é encerrado. O dono nunca paga a consulta.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class GuestRevocationTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    private static async Task<HttpResponseMessage> OpenStreamAsync(TvApp app, string ticket)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/tv/events");
        request.Headers.Add("Cookie", $"uo_st={ticket}");
        return await app.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, Ct);
    }

    private static async Task<string> TicketAsync(TvApp app, string bearer)
    {
        using var response = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: bearer);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return IdentityApp.Cookies(response).Single(c => c.Name == "uo_st").Value;
    }

    [Fact]
    public async Task RevokedGuest_ThroughTheApi_LosesTheTvAtOnce_WithTheShortJwtStillValid()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var before = await app.GetAsync("/api/v1/tv/state", bearer: guest.Login.AccessToken);

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke");
        using var state = await app.GetAsync("/api/v1/tv/state", bearer: guest.Login.AccessToken);
        using var key = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/keys", new { key = "HOME" }, bearer: guest.Login.AccessToken);
        using var owner = await app.GetAsync("/api/v1/tv/state");

        before.StatusCode.Should().Be(HttpStatusCode.OK);
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        state.StatusCode.Should().Be(HttpStatusCode.Forbidden, "o JWT segue válido, mas a conta foi revogada");
        key.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        owner.StatusCode.Should().Be(HttpStatusCode.OK, "o dono não é afetado");
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0, "nada chegou à TV");
    }

    [Fact]
    public async Task RevokedGuest_OutsideThisInstance_LosesTheTvWithinTheCacheTtl()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var warm = await app.GetAsync("/api/v1/tv/state", bearer: guest.Login.AccessToken);

        // Revogação feita por outra instância: direto no banco, sem passar pela invalidação desta.
        await app.ExecuteSqlAsync($"UPDATE identity.users SET disabled_at = now() WHERE id = '{guest.UserId}'");
        using var withinTtl = await app.GetAsync("/api/v1/tv/state", bearer: guest.Login.AccessToken);
        app.Time.Advance(TimeSpan.FromSeconds(29));
        using var stillWithin = await app.GetAsync("/api/v1/tv/state", bearer: guest.Login.AccessToken);
        app.Time.Advance(TimeSpan.FromSeconds(2));
        using var afterTtl = await app.GetAsync("/api/v1/tv/state", bearer: guest.Login.AccessToken);

        warm.StatusCode.Should().Be(HttpStatusCode.OK);
        withinTtl.StatusCode.Should().Be(HttpStatusCode.OK, "dentro do prazo do cache a resposta anterior vale");
        stillWithin.StatusCode.Should().Be(HttpStatusCode.OK);
        afterTtl.StatusCode.Should().Be(HttpStatusCode.Forbidden, "passados os 30 s a conta revogada é recusada");
    }

    [Fact]
    public async Task GuestWhoseAccountVanished_IsRefusedOnTheTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        await app.ExecuteSqlAsync($"DELETE FROM identity.users WHERE id = '{guest.UserId}'");

        using var state = await app.GetAsync("/api/v1/tv/state", bearer: guest.Login.AccessToken);

        state.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Stream_AlreadyOpenForAGuest_ClosesOnceRevoked_AndStaysOpenForTheOwner()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var guestTicket = await TicketAsync(app, guest.Login.AccessToken);
        var ownerTicket = await TicketAsync(app, app.Login.AccessToken);
        using var guestResponse = await OpenStreamAsync(app, guestTicket);
        using var ownerResponse = await OpenStreamAsync(app, ownerTicket);
        using var guestReader = new SseReader(await guestResponse.Content.ReadAsStreamAsync(Ct));
        using var ownerReader = new SseReader(await ownerResponse.Content.ReadAsStreamAsync(Ct));
        (await guestReader.NextAsync())!.EventType.Should().Be("tv.state");
        (await guestReader.NextAsync())!.EventType.Should().Be("tv.shortcuts");
        (await ownerReader.NextAsync())!.EventType.Should().Be("tv.state");
        (await ownerReader.NextAsync())!.EventType.Should().Be("tv.shortcuts");

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke");
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Cada keep-alive confere o acesso: o fluxo do convidado termina e o do dono segue com keep-alives.
        var guestNext = guestReader.NextAsync();
        var ownerNext = ownerReader.NextAsync();
        while (!guestNext.IsCompleted)
        {
            app.Time.Advance(TimeSpan.FromSeconds(15));
            await Task.Delay(25, Ct);
        }

        (await guestNext).Should().BeNull("o fluxo do convidado revogado foi encerrado");
        (await Within(ownerNext))!.Comment.Should().Be("keep-alive");
    }

    [Fact]
    public async Task Guest_CanRefreshTheAppListAndLaunchApps_ButNotRenameOrHideThem()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.a.um", "Um"))));
        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.Shortcuts.AnyAsync(Ct);
        }, "atalho criado");
        Guid id;
        await using (var db = app.Db())
        {
            id = (await db.Shortcuts.SingleAsync(Ct)).Id;
        }

        using var rename = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{id}", new { customLabel = "Meu" }, bearer: guest.Login.AccessToken);
        using var hide = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{id}", new { enabled = false }, bearer: guest.Login.AccessToken);
        using var list = await app.GetAsync("/api/v1/tv/shortcuts", bearer: guest.Login.AccessToken);
        var launch = app.SendAsync(HttpMethod.Post, $"/api/v1/tv/shortcuts/{id}/launch", bearer: guest.Login.AccessToken);
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command);
        using var launched = await Within(launch);
        using var ownerRename = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{id}", new { customLabel = "Do dono" });

        rename.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        hide.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        list.StatusCode.Should().Be(HttpStatusCode.OK);
        launched.StatusCode.Should().Be(HttpStatusCode.OK);
        ownerRename.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = app.Db();
        (await check.Shortcuts.SingleAsync(Ct)).CustomLabel.Should().Be("Do dono", "o convidado não mexeu no atalho");
    }

    [Fact]
    public async Task Fallback_RouteWithoutAnyPolicy_IsOwnerOnly_ButTheRouterStill404sAndAnonymousStill401s()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var owner = await app.LoginAsync();

        using var anonymous = await app.GetAsync("/api/test/default");
        using var asOwner = await app.GetAsync("/api/test/default", bearer: owner.AccessToken);
        using var asGuest = await app.GetAsync("/api/test/default", bearer: guest.Login.AccessToken);
        using var unknownAsGuest = await app.GetAsync("/api/v1/identity/nao-existe", bearer: guest.Login.AccessToken);
        using var plainAsGuest = await app.GetAsync("/api/test/protected", bearer: guest.Login.AccessToken);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        asOwner.StatusCode.Should().Be(HttpStatusCode.OK);
        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden, "sem política declarada a rota é só do dono");
        plainAsGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        unknownAsGuest.StatusCode.Should().Be(HttpStatusCode.NotFound, "o 404 do roteador não vira 403");
    }

    [Fact]
    public async Task Accept_HasItsOwnRateLimit_NotSharedWithTheLoginBucket()
    {
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions
        {
            Extra = new Dictionary<string, string?> { ["RateLimiting:login:Permitted"] = "1" },
        });

        // O balde do login (1 por minuto aqui) não afeta o aceite: cinco tentativas seguidas passam pelo limite.
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 5; i++)
        {
            using var response = await GuestSeed.AcceptAsync(app.Client, "curto", GuestSeed.NewEmail(), GuestSeed.NewPassword());
            statuses.Add(response.StatusCode);
        }

        statuses.Should().OnlyContain(s => s == HttpStatusCode.Gone);
    }

    [Fact]
    public async Task Accept_DefaultLimitIsTenPerMinutePerIp_With429AndRetryAfter()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        var statuses = new List<HttpStatusCode>();
        HttpResponseMessage? last = null;
        for (var i = 0; i < 11; i++)
        {
            last?.Dispose();
            last = await GuestSeed.AcceptAsync(app.Client, "curto", GuestSeed.NewEmail(), GuestSeed.NewPassword());
            statuses.Add(last.StatusCode);
        }

        statuses.Take(10).Should().OnlyContain(s => s == HttpStatusCode.Gone);
        statuses[10].Should().Be(HttpStatusCode.TooManyRequests);
        last!.Headers.RetryAfter.Should().NotBeNull();
        last.Dispose();
    }
}
