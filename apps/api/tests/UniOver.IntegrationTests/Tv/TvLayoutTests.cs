using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv.Domain;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class TvLayoutTests(PostgresFixture postgres)
{
    private static readonly object Layout = new
    {
        name = "Sala", buttonSize = "large", showMedia = true, showChannel = false,
        startPage = "last", padSpeed = "normal", pillLayout = "row",
        extraKeys = new[] { "INPUT" }, dismissedSuggestions = Array.Empty<string>(),
    };

    private static async Task<Guid> BindDefaultAsync(TvApp app)
    {
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, "tv.bind-agent");
        using var response = await app.SendAsync(HttpMethod.Put, "/api/v1/tv/config/agent", new { agentSlug = app.Agent.Slug });
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        return await db.Tvs.Where(tv => tv.IsDefault).Select(tv => tv.Id).SingleAsync(TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task OwnerDefinesBase_OnlyMembersReadIt_AndEachTvKeepsItsOwn()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var casa = await BindDefaultAsync(app);
        var agent = await app.PairAsync("PC Raphael");
        using var created = await app.PostAsync("/api/v1/tv/tvs", new { agentSlug = agent.Slug, name = "Raphael" });
        created.StatusCode.Should().Be(HttpStatusCode.OK);
        var raphael = (await TvApp.JsonAsync(created)).GetProperty("id").GetGuid();
        var alice = await app.NewGuestAsync("Alice", ["module:tv"], 112);
        var guest = await app.NewGuestAsync("Raphael", ["module:tv"], 113);
        using var members = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/tvs/{raphael}/members", new { userIds = new[] { guest.UserId } });
        members.StatusCode.Should().Be(HttpStatusCode.OK);

        using var saved = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/layout?tvId={casa}", Layout);
        saved.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(saved)).GetProperty("name").GetString().Should().Be("Sala");

        using var aliceRead = await app.GetAsync($"/api/v1/tv/layout?tvId={casa}", alice.Login.AccessToken);
        aliceRead.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(aliceRead)).GetProperty("buttonSize").GetString().Should().Be("large");

        using var forbiddenWrite = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/layout?tvId={casa}", Layout, alice.Login.AccessToken);
        forbiddenWrite.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        using var wrongTv = await app.GetAsync($"/api/v1/tv/layout?tvId={casa}", guest.Login.AccessToken);
        wrongTv.StatusCode.Should().Be(HttpStatusCode.NotFound);
        using var otherBase = await app.GetAsync($"/api/v1/tv/layout?tvId={raphael}");
        otherBase.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var seed = await app.PostAsync($"/api/v1/tv/layout?tvId={casa}", Layout);
        seed.StatusCode.Should().Be(HttpStatusCode.Conflict);
        using var stillSaved = await app.GetAsync($"/api/v1/tv/layout?tvId={casa}");
        (await TvApp.JsonAsync(stillSaved)).GetProperty("name").GetString().Should().Be("Sala");
    }

    [Fact]
    public async Task LayoutRejectsUnknownFieldsInvalidValuesAndUnboundedLists()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tv = await BindDefaultAsync(app);
        var invalid = new object[]
        {
            new { name = "Sala", buttonSize = "large", showMedia = true, showChannel = true, startPage = "last", padSpeed = "normal", pillLayout = "sides", extraKeys = (string[]?)null, dismissedSuggestions = Array.Empty<string>(), vibration = false },
            new { name = new string('x', 21), buttonSize = "large", showMedia = true, showChannel = true, startPage = "last", padSpeed = "normal", pillLayout = "sides", extraKeys = (string[]?)null, dismissedSuggestions = Array.Empty<string>() },
            new { name = "Sala", buttonSize = "huge", showMedia = true, showChannel = true, startPage = "last", padSpeed = "normal", pillLayout = "sides", extraKeys = (string[]?)null, dismissedSuggestions = Array.Empty<string>() },
            new { name = "Sala", buttonSize = "large", showMedia = true, showChannel = true, startPage = "last", padSpeed = "normal", pillLayout = "sides", extraKeys = (string[]?)null, dismissedSuggestions = Enumerable.Range(0, 21).Select(i => $"app-{i}").ToArray() },
        };
        foreach (var body in invalid)
        {
            using var response = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/layout?tvId={tv}", body);
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            (await TvApp.JsonAsync(response)).GetProperty("errors").GetProperty("body").GetArrayLength().Should().BeGreaterThan(0);
        }
    }

    [Fact]
    public async Task ForeignUninstalledShortcutsDisappearOnReadAndAreDeletedOnNextAgentList()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tv = await BindDefaultAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();
        await using (var db = app.Db())
        {
            var old = Shortcut.Create(tv, "samsung.app.old", "Antigo", 1, app.Time.GetUtcNow());
            db.Shortcuts.Add(old);
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.sala", "Sala"))));
        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.Shortcuts.AnyAsync(s => s.TvId == tv && s.Package == "samsung.app.old" && !s.Installed);
        }, "atalho antigo desinstalado");
        await agent.SendHelloAsync("2.0.0", "tv.remote", "tv.kind.android");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.kind.android", StringComparer.Ordinal) == true, "família da TV");
        using var read = await app.GetAsync($"/api/v1/tv/shortcuts?tvId={tv}");
        var packages = (await TvApp.JsonAsync(read)).EnumerateArray().Select(item => item.GetProperty("package").GetString());
        packages.Should().Contain("com.sala").And.NotContain("samsung.app.old");
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.sala", "Sala"))));
        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return !await db.Shortcuts.AnyAsync(s => s.TvId == tv && s.Package == "samsung.app.old");
        }, "atalho de outra família removido");
        await using var check = app.Db();
        (await check.Shortcuts.AnyAsync(s => s.TvId == tv && s.Package == "samsung.app.old", TestContext.Current.CancellationToken)).Should().BeFalse();
    }
}
