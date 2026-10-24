using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv.Domain;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// TVs diferentes podem dividir a API sem dividir controle, atalhos ou histórico. O agente falso recebe o contrato de
/// verdade, por isso uma seleção errada de TV aparece como comando no computador errado.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class MultipleTvsTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<VirtualAuthenticator> ConfirmedOwnerAsync(TvApp app)
    {
        var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, "tv.bind-agent");
        return authenticator;
    }

    private static async Task<Guid> BindDefaultAsync(TvApp app)
    {
        using var response = await app.SendAsync(HttpMethod.Put, "/api/v1/tv/config/agent", new { agentSlug = app.Agent.Slug });
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        return (await db.Tvs.AsNoTracking().SingleAsync(t => t.IsDefault, Ct)).Id;
    }

    private static async Task<Guid> CreateTvAsync(TvApp app, string agentSlug, string name)
    {
        using var response = await app.PostAsync("/api/v1/tv/tvs", new { agentSlug, name });
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await TvApp.JsonAsync(response)).GetProperty("id").GetGuid();
    }

    private static async Task SetMembersAsync(TvApp app, Guid tvId, params Guid[] userIds)
    {
        using var response = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/tvs/{tvId}/members", new { userIds });
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task List_SeparatesMembersFromLegacyAccounts_AndIncludesTheConnectedAgentsKind()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var defaultTvId = await BindDefaultAsync(app);
        var raphaelAgent = await app.PairAsync("PC Raphael");
        var raphaelTvId = await CreateTvAsync(app, raphaelAgent.Slug, "TV Raphael");
        var member = await app.NewGuestAsync("Raphael", ["module:tv", "tv:control"], 81);
        var legacy = await app.NewGuestAsync("Legado", ["module:tv"], 82);
        await SetMembersAsync(app, raphaelTvId, member.UserId);

        await using var raphaelConnection = await app.ConnectAsync(raphaelAgent);
        await raphaelConnection.SendHelloAsync("2.0.0", "tv.remote", "tv.kind.samsung");
        await TvApp.WaitUntilAsync(
            () => app.Presence.Get(raphaelAgent.Slug)?.Capabilities.Contains("tv.kind.samsung", StringComparer.Ordinal) == true,
            "capacidades Samsung do agente");

        using (var owner = await app.GetAsync("/api/v1/tv/tvs"))
        {
            owner.StatusCode.Should().Be(HttpStatusCode.OK);
            var items = (await TvApp.JsonAsync(owner)).GetProperty("items").EnumerateArray().ToList();
            items.Select(item => item.GetProperty("id").GetGuid()).Should().BeEquivalentTo(new[] { defaultTvId, raphaelTvId });
            var raphael = items.Single(item => item.GetProperty("id").GetGuid() == raphaelTvId);
            raphael.GetProperty("agentSlug").GetString().Should().Be(raphaelAgent.Slug);
            raphael.GetProperty("kind").GetString().Should().Be("samsung");
            raphael.GetProperty("online").GetBoolean().Should().BeTrue();
            raphael.GetProperty("capabilities").EnumerateArray().Select(value => value.GetString()).Should().Contain("tv.kind.samsung");
        }

        using (var members = await app.GetAsync($"/api/v1/tv/tvs/{raphaelTvId}/members"))
        {
            members.StatusCode.Should().Be(HttpStatusCode.OK);
            (await TvApp.JsonAsync(members)).GetProperty("userIds").EnumerateArray().Select(value => value.GetGuid()).Should().Equal(member.UserId);
        }

        using (var memberList = await app.GetAsync("/api/v1/tv/tvs", member.Login.AccessToken))
        {
            memberList.StatusCode.Should().Be(HttpStatusCode.OK);
            var item = (await TvApp.JsonAsync(memberList)).GetProperty("items").EnumerateArray().Should().ContainSingle().Subject;
            item.GetProperty("id").GetGuid().Should().Be(raphaelTvId);
            item.GetProperty("agentSlug").ValueKind.Should().Be(JsonValueKind.Null, "só o administrador recebe o identificador do agente");
        }

        using (var legacyList = await app.GetAsync("/api/v1/tv/tvs", legacy.Login.AccessToken))
        {
            legacyList.StatusCode.Should().Be(HttpStatusCode.OK);
            var item = (await TvApp.JsonAsync(legacyList)).GetProperty("items").EnumerateArray().Should().ContainSingle().Subject;
            item.GetProperty("id").GetGuid().Should().Be(defaultTvId, "sem filiação, a conta antiga continua na TV padrão");
        }

        using var repeated = await app.PostAsync("/api/v1/tv/tvs", new { agentSlug = raphaelAgent.Slug, name = "Duplicada" });
        repeated.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task SelectedTv_RestrictsStateCommandsEventsAndShortcutsToTheVisibleTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var defaultTvId = await BindDefaultAsync(app);
        var raphaelAgent = await app.PairAsync("PC Raphael");
        var raphaelTvId = await CreateTvAsync(app, raphaelAgent.Slug, "TV Raphael");
        var member = await app.NewGuestAsync("Raphael", ["module:tv", "tv:control"], 83);
        await SetMembersAsync(app, raphaelTvId, member.UserId);

        await using var defaultConnection = await app.ConnectAndWaitAsync();
        await using var raphaelConnection = await app.ConnectAsync(raphaelAgent);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(raphaelAgent.Slug)?.Connected == true, "agente da TV do membro conectado");

        await defaultConnection.SendTextAsync(defaultConnection.Envelope("tv.apps.v1", TvApp.AppsBody(("com.sala", "Sala"))));
        await raphaelConnection.SendTextAsync(raphaelConnection.Envelope("tv.apps.v1", TvApp.AppsBody(("com.raphael", "Raphael"))));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var response = await app.GetAsync($"/api/v1/tv/shortcuts?tvId={raphaelTvId}");
            return response.StatusCode == HttpStatusCode.OK
                && (await TvApp.JsonAsync(response)).EnumerateArray().Any(shortcut => shortcut.GetProperty("package").GetString() == "com.raphael");
        }, "atalho isolado da TV do membro");

        using (var selected = await app.GetAsync($"/api/v1/tv/shortcuts?tvId={raphaelTvId}", member.Login.AccessToken))
        {
            selected.StatusCode.Should().Be(HttpStatusCode.OK);
            (await TvApp.JsonAsync(selected)).EnumerateArray().Select(shortcut => shortcut.GetProperty("package").GetString()).Should().Equal("com.raphael");
        }

        foreach (var response in new[]
        {
            await app.GetAsync($"/api/v1/tv/state?tvId={defaultTvId}", member.Login.AccessToken),
            await app.SendAsync(HttpMethod.Post, $"/api/v1/tv/keys?tvId={defaultTvId}", new { key = "HOME" }, member.Login.AccessToken),
        })
        {
            using (response)
            {
                response.StatusCode.Should().Be(HttpStatusCode.NotFound, "a TV sem filiação não pode ser distinguida de uma inexistente");
            }
        }

        var ticket = await app.StreamTicketAsync(member.Login.AccessToken);
        using (var events = await app.OpenEventsAsync(ticket, $"?tvId={defaultTvId}"))
        {
            events.StatusCode.Should().Be(HttpStatusCode.NotFound);
        }

        var commandRequest = app.SendAsync(
            HttpMethod.Post, $"/api/v1/tv/keys?tvId={raphaelTvId}", new { key = "HOME" }, member.Login.AccessToken);
        var command = await TvApp.NextCommandAsync(raphaelConnection);
        command.GetProperty("target").GetString().Should().Be($"agent:{raphaelAgent.Slug}");
        await TvApp.ReplyAsync(raphaelConnection, command);
        using (var delivered = await commandRequest.WaitAsync(FakeAgent.Patience, Ct))
        {
            delivered.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await using var db = app.Db();
        var audit = await db.CommandAudit.AsNoTracking().SingleAsync(entry => entry.Command == TvCommandNames.Key, Ct);
        audit.TvId.Should().Be(raphaelTvId);
        (await db.Shortcuts.AsNoTracking().Where(shortcut => shortcut.TvId == defaultTvId).Select(shortcut => shortcut.Package).ToListAsync(Ct)).Should().Equal("com.sala");
        (await db.Shortcuts.AsNoTracking().Where(shortcut => shortcut.TvId == raphaelTvId).Select(shortcut => shortcut.Package).ToListAsync(Ct)).Should().Equal("com.raphael");
    }

    [Fact]
    public async Task Members_RequireAnAdministratorWithARecentStrongConfirmation_AndTheDefaultCannotBeDeleted()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("Convidado", ["module:tv"], 84);

        using (var withoutConfirmation = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/tvs/{Guid.NewGuid()}/members", new { userIds = new[] { guest.UserId } }))
        {
            withoutConfirmation.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }

        using var authenticator = await ConfirmedOwnerAsync(app);
        var defaultTvId = await BindDefaultAsync(app);
        using (var asGuest = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/tvs/{defaultTvId}/members", new { userIds = new[] { guest.UserId } }, guest.Login.AccessToken))
        {
            asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }

        using var deleteDefault = await app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/tvs/{defaultTvId}");
        deleteDefault.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task WithoutTvId_EachAccountLandsOnItsOwnTv_AndOnlyANonDefaultTvCanBeDeleted()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var raphaelAgent = await app.PairAsync("PC Raphael");
        var raphaelTvId = await CreateTvAsync(app, raphaelAgent.Slug, "TV Raphael");
        var member = await app.NewGuestAsync("Raphael", ["module:tv", "tv:control"], 85);
        await SetMembersAsync(app, raphaelTvId, member.UserId);

        await using var defaultConnection = await app.ConnectAndWaitAsync();
        await using var raphaelConnection = await app.ConnectAsync(raphaelAgent);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(raphaelAgent.Slug)?.Connected == true, "agente da TV do membro conectado");
        await defaultConnection.SendTextAsync(defaultConnection.Envelope("tv.apps.v1", TvApp.AppsBody(("com.sala", "Sala"))));
        await raphaelConnection.SendTextAsync(raphaelConnection.Envelope("tv.apps.v1", TvApp.AppsBody(("com.raphael", "Raphael"))));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var response = await app.GetAsync($"/api/v1/tv/shortcuts?tvId={raphaelTvId}");
            return response.StatusCode == HttpStatusCode.OK && (await TvApp.JsonAsync(response)).GetArrayLength() > 0;
        }, "atalhos das duas TVs gravados");

        // Sem tvId o membro cai na única TV visível para ele e o administrador, na padrão.
        using (var asMember = await app.GetAsync("/api/v1/tv/shortcuts", member.Login.AccessToken))
        {
            (await TvApp.JsonAsync(asMember)).EnumerateArray().Select(shortcut => shortcut.GetProperty("package").GetString()).Should().Equal("com.raphael");
        }

        using (var asOwner = await app.GetAsync("/api/v1/tv/shortcuts"))
        {
            (await TvApp.JsonAsync(asOwner)).EnumerateArray().Select(shortcut => shortcut.GetProperty("package").GetString()).Should().Equal("com.sala");
        }

        using (var removed = await app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/tvs/{raphaelTvId}"))
        {
            removed.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.NoContent);
        }

        using var afterRemoval = await app.GetAsync($"/api/v1/tv/shortcuts?tvId={raphaelTvId}");
        afterRemoval.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
