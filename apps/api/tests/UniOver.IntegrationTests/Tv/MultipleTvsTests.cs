using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Guests;
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

    private static readonly string[] RestrictedApps = ["com.exemplo.video"];

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
            item.GetProperty("id").GetGuid().Should().Be(defaultTvId, "quem nunca teve filiação continua na TV padrão (conta de antes das várias TVs)");
        }

        using var repeated = await app.PostAsync("/api/v1/tv/tvs", new { agentSlug = raphaelAgent.Slug, name = "Duplicada" });
        repeated.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task BackgroundAppClosing_IsOffByDefault_AuditsTheChange_AndReachesTheAgent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var agent = await app.PairAsync("PC Sala");
        var tvId = await CreateTvAsync(app, agent.Slug, "TV Sala");

        await using var connection = await app.ConnectAsync(agent);
        await connection.SendHelloAsync("2.0.0", "tv.remote", "tv.cleanup.automatic.v1");
        // Ao conectar, o agente recebe a configuração com o fechamento de apps desligado.
        var first = await TvApp.NextCommandAsync(connection);
        first.GetProperty("type").GetString().Should().Be("tv.cleanup.config.v1");
        first.GetProperty("body").GetProperty("closeBackgroundApps").GetBoolean().Should().BeFalse();

        using (var list = await app.GetAsync("/api/v1/tv/tvs"))
        {
            var item = (await TvApp.JsonAsync(list)).GetProperty("items").EnumerateArray()
                .Single(i => i.GetProperty("id").GetGuid() == tvId);
            item.GetProperty("allowBackgroundAppClosing").GetBoolean().Should().BeFalse();
        }

        using (var on = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { allowBackgroundAppClosing = true }))
        {
            on.StatusCode.Should().Be(HttpStatusCode.OK);
            (await TvApp.JsonAsync(on)).GetProperty("allowBackgroundAppClosing").GetBoolean().Should().BeTrue();
        }

        var changed = await TvApp.NextCommandAsync(connection);
        changed.GetProperty("type").GetString().Should().Be("tv.cleanup.config.v1");
        changed.GetProperty("body").GetProperty("closeBackgroundApps").GetBoolean().Should().BeTrue();

        // Repetir o mesmo valor não grava de novo nem republica.
        using (var same = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { allowBackgroundAppClosing = true }))
        {
            same.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using (var off = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { allowBackgroundAppClosing = false }))
        {
            off.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await using var db = app.Db();
        var trail = await db.CommandAudit.AsNoTracking()
            .Where(a => a.Command == TvCommandNames.CleanupSetting && a.TvId == tvId)
            .OrderBy(a => a.OccurredAt).Select(a => a.Detail).ToListAsync(Ct);
        trail.Should().Equal("background-app-closing=on", "background-app-closing=off");
        (await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == tvId, Ct)).AllowBackgroundAppClosing.Should().BeFalse();
    }

    [Fact]
    public async Task LightSettings_StartOff_AreAuditedWithoutThePackageList_ReachTheAgent_AndRefuseTooManyApps()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var agent = await app.PairAsync("PC Sala");
        var tvId = await CreateTvAsync(app, agent.Slug, "TV Sala");

        await using var connection = await app.ConnectAsync(agent);
        await connection.SendHelloAsync("2.0.0", "tv.remote", "tv.cleanup.automatic.v1", "tv.light-settings.v1");
        var first = (await TvApp.NextCommandAsync(connection)).GetProperty("body");
        (first.GetProperty("focusEnabled").GetBoolean(), first.GetProperty("shortAnimationsEnabled").GetBoolean(),
            first.GetProperty("restrictedPackages").GetArrayLength()).Should().Be((false, false, 0));

        using (var on = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new
        {
            focusModeEnabled = true,
            shortAnimationsEnabled = true,
            restrictedBackgroundPackages = RestrictedApps,
        }))
        {
            on.StatusCode.Should().Be(HttpStatusCode.OK);
            (await TvApp.JsonAsync(on)).GetProperty("restrictedBackgroundPackages").EnumerateArray()
                .Select(p => p.GetString()).Should().Equal("com.exemplo.video");
        }

        var changed = (await TvApp.NextCommandAsync(connection)).GetProperty("body");
        (changed.GetProperty("focusEnabled").GetBoolean(), changed.GetProperty("shortAnimationsEnabled").GetBoolean())
            .Should().Be((true, true));
        changed.GetProperty("restrictedPackages").EnumerateArray().Select(p => p.GetString()).Should().Equal("com.exemplo.video");

        using (var tooMany = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new
        {
            restrictedBackgroundPackages = Enumerable.Range(0, 101).Select(i => $"com.exemplo.app{i}").ToArray(),
        }))
        {
            tooMany.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        using (var apps = await app.GetAsync($"/api/v1/tv/tvs/{tvId}/apps"))
        {
            apps.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await using var db = app.Db();
        var trail = await db.CommandAudit.AsNoTracking()
            .Where(a => a.Command == TvCommandNames.CleanupSetting && a.TvId == tvId).Select(a => a.Detail).ToListAsync(Ct);
        trail.Should().Equal("light-settings");
    }

    [Fact]
    public async Task FocusClosesBackground_OnlyReachesAgentsThatKnowIt_AndOnlyWithFocusModeOn()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var agent = await app.PairAsync("PC Sala");
        var tvId = await CreateTvAsync(app, agent.Slug, "TV Sala");

        await using var connection = await app.ConnectAsync(agent);
        await connection.SendHelloAsync(
            "2.0.0", "tv.remote", "tv.cleanup.automatic.v1", "tv.light-settings.v1", "tv.focus-closes-background.v1");
        (await TvApp.NextCommandAsync(connection)).GetProperty("body").GetProperty("focusClosesBackground").GetBoolean()
            .Should().BeFalse();

        using (var on = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new
        {
            focusModeEnabled = true,
            focusClosesBackground = true,
        }))
        {
            on.StatusCode.Should().Be(HttpStatusCode.OK);
            (await TvApp.JsonAsync(on)).GetProperty("focusClosesBackground").GetBoolean().Should().BeTrue();
        }

        (await TvApp.NextCommandAsync(connection)).GetProperty("body").GetProperty("focusClosesBackground").GetBoolean()
            .Should().BeTrue();

        // Com o Modo Foco desligado a preferência fica guardada, mas o agente recebe falso: nada é fechado.
        using (var off = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { focusModeEnabled = false }))
        {
            off.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        (await TvApp.NextCommandAsync(connection)).GetProperty("body").GetProperty("focusClosesBackground").GetBoolean()
            .Should().BeFalse();
    }

    [Fact]
    public async Task FocusClosesBackground_IsRefusedForAnAgentWithoutTheCapability_AndTheFieldIsNeverSent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var agent = await app.PairAsync("PC Sala");
        var tvId = await CreateTvAsync(app, agent.Slug, "TV Sala");

        await using var connection = await app.ConnectAsync(agent);
        await connection.SendHelloAsync("2.0.0", "tv.remote", "tv.cleanup.automatic.v1", "tv.light-settings.v1");
        var body = (await TvApp.NextCommandAsync(connection)).GetProperty("body");
        body.TryGetProperty("focusClosesBackground", out _).Should().BeFalse();
        body.GetProperty("focusEnabled").GetBoolean().Should().BeFalse();

        using (var on = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new
        {
            focusModeEnabled = true,
            focusClosesBackground = true,
        }))
        {
            on.StatusCode.Should().Be(HttpStatusCode.Conflict);
            (await TvApp.JsonAsync(on)).GetProperty("type").GetString().Should().EndWith("/tv-light-settings-unsupported");
        }

        await using var db = app.Db();
        (await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == tvId, Ct)).FocusClosesBackground.Should().BeFalse();
    }

    [Fact]
    public async Task AutoMaintenance_IsOnByDefault_ReachesOnlyAgentsThatAnnounceIt_AndFollowsTheSwitch()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var samsung = await app.PairAsync("PC Raphael");
        var android = await app.PairAsync("PC Sala");
        var samsungTv = await CreateTvAsync(app, samsung.Slug, "TV Raphael");
        var androidTv = await CreateTvAsync(app, android.Slug, "TV Sala");

        // A Samsung anuncia só a manutenção: a configuração chega mesmo sem a limpeza do Android.
        await using var samsungConnection = await app.ConnectAsync(samsung);
        await samsungConnection.SendHelloAsync("2.0.0", "tv.remote", "tv.kind.samsung", "tv.maintenance.v1");
        var first = (await TvApp.NextCommandAsync(samsungConnection)).GetProperty("body");
        first.GetProperty("maintenanceEnabled").GetBoolean().Should().BeTrue();

        await using var androidConnection = await app.ConnectAsync(android);
        await androidConnection.SendHelloAsync("2.0.0", "tv.remote", "tv.cleanup.automatic.v1");
        (await TvApp.NextCommandAsync(androidConnection)).GetProperty("body")
            .TryGetProperty("maintenanceEnabled", out _).Should().BeFalse();

        using (var off = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{samsungTv}", new { autoMaintenanceEnabled = false }))
        {
            off.StatusCode.Should().Be(HttpStatusCode.OK);
            (await TvApp.JsonAsync(off)).GetProperty("autoMaintenanceEnabled").GetBoolean().Should().BeFalse();
        }

        (await TvApp.NextCommandAsync(samsungConnection)).GetProperty("body").GetProperty("maintenanceEnabled")
            .GetBoolean().Should().BeFalse();

        await using var db = app.Db();
        (await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == samsungTv, Ct)).AutoMaintenanceEnabled.Should().BeFalse();
        (await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == androidTv, Ct)).AutoMaintenanceEnabled.Should().BeTrue();
        (await db.CommandAudit.AsNoTracking().Where(a => a.TvId == samsungTv).Select(a => a.Detail).ToListAsync(Ct))
            .Should().Contain("auto-maintenance=off");
    }

    [Fact]
    public async Task CleanupConfig_ForAnAgentWithoutLightSettings_KeepsExactlyTheOldBody()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var agent = await app.PairAsync("PC Raphael");
        var tvId = await CreateTvAsync(app, agent.Slug, "TV Raphael");

        await using var connection = await app.ConnectAsync(agent);
        await connection.SendHelloAsync("2.0.0", "tv.remote", "tv.cleanup.automatic.v1");
        var first = (await TvApp.NextCommandAsync(connection)).GetProperty("body");
        // O schema antigo tem additionalProperties:false: qualquer campo a mais derrubaria a mensagem inteira.
        first.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal)
            .Should().Equal("closeBackgroundApps", "deepEnabled", "deepThresholdMb", "lightEnabled");

        using (var on = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { focusModeEnabled = true, allowBackgroundAppClosing = true }))
        {
            on.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var changed = (await TvApp.NextCommandAsync(connection)).GetProperty("body");
        changed.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal)
            .Should().Equal("closeBackgroundApps", "deepEnabled", "deepThresholdMb", "lightEnabled");
        changed.GetProperty("closeBackgroundApps").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task LightSettings_RefuseAnInvalidAppList_WithAFieldError()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var agent = await app.PairAsync("PC Sala");
        var tvId = await CreateTvAsync(app, agent.Slug, "TV Sala");

        var invalid = new object?[]
        {
            new string?[] { "com.exemplo.a", null },
            new[] { "semponto" },
            new[] { "com.exemplo; reboot" },
            new[] { "com.exemplo.a", "com.exemplo.a" },
            new[] { "com.android.vending" },
            new[] { "com.google.android.tv.remote.service" },
            Enumerable.Range(0, 101).Select(i => $"com.exemplo.app{i}").ToArray(),
        };
        foreach (var list in invalid)
        {
            using var response = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { restrictedBackgroundPackages = list });
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            (await TvApp.JsonAsync(response)).GetProperty("errors").TryGetProperty("restrictedBackgroundPackages", out _).Should().BeTrue();
        }

        await using var db = app.Db();
        (await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == tvId, Ct)).BackgroundPackages().Should().BeEmpty();
    }

    [Fact]
    public async Task LightSettings_AreRefusedForASamsungTv_ButTurningThemOffIsAccepted()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var agent = await app.PairAsync("PC Raphael");
        var tvId = await CreateTvAsync(app, agent.Slug, "TV Raphael");

        await using var connection = await app.ConnectAsync(agent);
        await connection.SendHelloAsync("2.0.0", "tv.remote", "tv.kind.samsung");
        await TvApp.WaitUntilAsync(
            () => app.Presence.Get(agent.Slug)?.Capabilities.Contains("tv.kind.samsung", StringComparer.Ordinal) == true,
            "capacidade da Samsung anunciada");

        using (var on = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { shortAnimationsEnabled = true }))
        {
            on.StatusCode.Should().Be(HttpStatusCode.Conflict);
            // Código estável: a tela não pode confundir esta recusa com "computador já em uso" (também 409).
            (await TvApp.JsonAsync(on)).GetProperty("type").GetString().Should().EndWith("/tv-light-settings-unsupported");
        }

        using (var off = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { shortAnimationsEnabled = false }))
        {
            off.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await using var db = app.Db();
        (await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == tvId, Ct)).ShortAnimationsEnabled.Should().BeFalse();
    }

    [Fact]
    public async Task AutomaticCleanupReports_AreStored_AndListedForTheAdministratorWithTheReasonItSkipped()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var tvId = await BindDefaultAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();

        var requestId = Guid.NewGuid();
        await agent.SendTextAsync(agent.Envelope("tv.cleanup.result.v1", new System.Text.Json.Nodes.JsonObject
        {
            ["requestId"] = requestId.ToString(),
            ["closedApps"] = 0,
            ["closedPackages"] = new System.Text.Json.Nodes.JsonArray(),
            ["memoryBeforeMb"] = null,
            ["memoryAfterMb"] = null,
            ["freedMb"] = null,
            ["failedSteps"] = new System.Text.Json.Nodes.JsonArray(),
            ["at"] = "2026-10-27T12:00:00Z",
            ["kind"] = "deep",
            ["trigger"] = "automatic",
            ["result"] = "skipped",
            ["reason"] = "media-in-use",
            ["durationMs"] = 0,
        }, requestId));

        await TvApp.WaitUntilAsync(() =>
        {
            using var db = app.Db();
            return db.CleanupReports.Any(r => r.TvId == tvId);
        }, "relatório automático gravado");

        using var response = await app.GetAsync($"/api/v1/tv/tvs/{tvId}/cleanup-reports");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var item = (await TvApp.JsonAsync(response)).GetProperty("items").EnumerateArray().Should().ContainSingle().Subject;
        (item.GetProperty("kind").GetString(), item.GetProperty("trigger").GetString(), item.GetProperty("result").GetString(),
            item.GetProperty("reason").GetString(), item.GetProperty("closedApps").GetInt32())
            .Should().Be(("deep", "automatic", "skipped", "media-in-use", 0));

        using var missing = await app.GetAsync($"/api/v1/tv/tvs/{Guid.NewGuid()}/cleanup-reports");
        missing.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task BackgroundAppClosing_RequiresAnAdministratorWithARecentStrongConfirmation()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("Convidado", ["module:tv"], 85);

        using (var withoutConfirmation = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{Guid.NewGuid()}", new { allowBackgroundAppClosing = true }))
        {
            withoutConfirmation.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }

        using var authenticator = await ConfirmedOwnerAsync(app);
        var defaultTvId = await BindDefaultAsync(app);
        using (var asGuest = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{defaultTvId}", new { allowBackgroundAppClosing = true }, guest.Login.AccessToken))
        {
            asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }

        await using var db = app.Db();
        (await db.Tvs.AsNoTracking().SingleAsync(t => t.Id == defaultTvId, Ct)).AllowBackgroundAppClosing.Should().BeFalse();
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

    // ---- quem perde a última TV não herda a TV padrão do dono ----

    private static async Task<bool> HasOptOutAsync(TvApp app, Guid userId)
    {
        await using var db = app.Db();
        return await db.TvMemberOptOuts.AsNoTracking().AnyAsync(o => o.UserId == userId, Ct);
    }

    private static async Task<int> MembershipCountAsync(TvApp app, Guid userId)
    {
        await using var db = app.Db();
        return await db.TvMembers.AsNoTracking().CountAsync(m => m.UserId == userId, Ct);
    }

    private static async Task<List<Guid>> VisibleTvIdsAsync(TvApp app, string bearer)
    {
        using var response = await app.GetAsync("/api/v1/tv/tvs", bearer);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return [.. (await TvApp.JsonAsync(response)).GetProperty("items").EnumerateArray().Select(item => item.GetProperty("id").GetGuid())];
    }

    /// <summary>
    /// A conta não alcança TV nenhuma: lista vazia e 404 em toda rota de controle, com e sem <c>tvId</c>. Sem o teste
    /// sem <c>tvId</c> a reserva do agente do ambiente passaria despercebida como segunda porta para a TV do dono.
    /// </summary>
    private static async Task AssertReachesNoTvAsync(TvApp app, GuestSession guest, Guid otherTvId)
    {
        (await VisibleTvIdsAsync(app, guest.Login.AccessToken)).Should().BeEmpty();

        var statuses = new List<(string Name, HttpStatusCode Status)>();

        async Task RecordAsync(string name, Task<HttpResponseMessage> request)
        {
            using var response = await request;
            statuses.Add((name, response.StatusCode));
        }

        var bearer = guest.Login.AccessToken;
        await RecordAsync("GET state", app.GetAsync("/api/v1/tv/state", bearer));
        await RecordAsync("GET shortcuts", app.GetAsync("/api/v1/tv/shortcuts", bearer));
        await RecordAsync("POST keys", app.SendAsync(HttpMethod.Post, "/api/v1/tv/keys", new { key = "HOME" }, bearer));
        await RecordAsync("GET state?tvId", app.GetAsync($"/api/v1/tv/state?tvId={otherTvId}", bearer));
        await RecordAsync("POST keys?tvId", app.SendAsync(HttpMethod.Post, $"/api/v1/tv/keys?tvId={otherTvId}", new { key = "HOME" }, bearer));
        await RecordAsync("GET events", app.OpenEventsAsync(await app.StreamTicketAsync(bearer)));

        statuses.Where(attempt => attempt.Status != HttpStatusCode.NotFound).Should().BeEmpty(
            "sem filiação e já retirada, a conta não enxerga TV nenhuma");
    }

    [Fact]
    public async Task MemberRemovedFromTheOnlyTv_SeesNoTv_InsteadOfFallingBackToTheOwnersDefault()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var defaultTvId = await BindDefaultAsync(app);
        var raphaelAgent = await app.PairAsync("PC Raphael");
        var raphaelTvId = await CreateTvAsync(app, raphaelAgent.Slug, "TV Raphael");
        var guest = await app.NewGuestAsync("Raphael", ["module:tv", "tv:control"], 86);
        await SetMembersAsync(app, raphaelTvId, guest.UserId);
        (await VisibleTvIdsAsync(app, guest.Login.AccessToken)).Should().Equal(raphaelTvId);
        (await HasOptOutAsync(app, guest.UserId)).Should().BeFalse("enquanto é membro, não há marca de retirada");

        await SetMembersAsync(app, raphaelTvId);

        await AssertReachesNoTvAsync(app, guest, defaultTvId);
        (await HasOptOutAsync(app, guest.UserId)).Should().BeTrue();

        // O administrador não muda: vê todas e cai na padrão sem tvId.
        (await VisibleTvIdsAsync(app, app.Login.AccessToken)).Should().BeEquivalentTo([defaultTvId, raphaelTvId]);
        using var asOwner = await app.GetAsync("/api/v1/tv/shortcuts");
        asOwner.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task MemberWhoseOnlyTvIsDeleted_SeesNoTv_InsteadOfFallingBackToTheOwnersDefault()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var defaultTvId = await BindDefaultAsync(app);
        var raphaelAgent = await app.PairAsync("PC Raphael");
        var raphaelTvId = await CreateTvAsync(app, raphaelAgent.Slug, "TV Raphael");
        var guest = await app.NewGuestAsync("Raphael", ["module:tv", "tv:control"], 87);
        await SetMembersAsync(app, raphaelTvId, guest.UserId);

        using (var deleted = await app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/tvs/{raphaelTvId}"))
        {
            deleted.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        await AssertReachesNoTvAsync(app, guest, defaultTvId);
        (await HasOptOutAsync(app, guest.UserId)).Should().BeTrue();
    }

    [Fact]
    public async Task MemberRemovedFromOneOfTwoTvs_KeepsTheOther_AndGetsNoOptOut()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var firstTvId = await CreateTvAsync(app, (await app.PairAsync("PC Um")).Slug, "TV Um");
        var secondTvId = await CreateTvAsync(app, (await app.PairAsync("PC Dois")).Slug, "TV Dois");
        var guest = await app.NewGuestAsync("Dois lares", ["module:tv", "tv:control"], 88);
        await SetMembersAsync(app, firstTvId, guest.UserId);
        await SetMembersAsync(app, secondTvId, guest.UserId);

        await SetMembersAsync(app, firstTvId);

        (await VisibleTvIdsAsync(app, guest.Login.AccessToken)).Should().Equal(secondTvId);
        (await HasOptOutAsync(app, guest.UserId)).Should().BeFalse("ainda é membro de outra TV");

        using var deleted = await app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/tvs/{secondTvId}");
        deleted.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await VisibleTvIdsAsync(app, guest.Login.AccessToken)).Should().BeEmpty("a última filiação saiu com a TV apagada");
        (await HasOptOutAsync(app, guest.UserId)).Should().BeTrue();
    }

    [Fact]
    public async Task AccountThatNeverHadAMembership_KeepsTheDefaultTv_EvenAfterOthersAreRemoved()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var defaultTvId = await BindDefaultAsync(app);
        var raphaelTvId = await CreateTvAsync(app, (await app.PairAsync("PC Raphael")).Slug, "TV Raphael");
        var removed = await app.NewGuestAsync("Retirado", ["module:tv", "tv:control"], 89);
        var legacy = await app.NewGuestAsync("Nunca membro", ["module:tv", "tv:control"], 90);
        await SetMembersAsync(app, raphaelTvId, removed.UserId);
        await SetMembersAsync(app, raphaelTvId);

        (await VisibleTvIdsAsync(app, legacy.Login.AccessToken)).Should().Equal(defaultTvId);
        using (var shortcuts = await app.GetAsync("/api/v1/tv/shortcuts", legacy.Login.AccessToken))
        {
            shortcuts.StatusCode.Should().Be(HttpStatusCode.OK, "sem tvId, quem nunca foi membro cai na TV padrão");
        }

        using var explicitDefault = await app.GetAsync($"/api/v1/tv/shortcuts?tvId={defaultTvId}", legacy.Login.AccessToken);
        explicitDefault.StatusCode.Should().Be(HttpStatusCode.OK);
        (await HasOptOutAsync(app, legacy.UserId)).Should().BeFalse();
        (await HasOptOutAsync(app, removed.UserId)).Should().BeTrue();
    }

    [Fact]
    public async Task RemovedMemberWhoBecomesAMemberAgain_SeesOnlyThatTv_AndTheOptOutIsGone()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var defaultTvId = await BindDefaultAsync(app);
        var raphaelTvId = await CreateTvAsync(app, (await app.PairAsync("PC Raphael")).Slug, "TV Raphael");
        var guest = await app.NewGuestAsync("Raphael", ["module:tv", "tv:control"], 91);
        await SetMembersAsync(app, raphaelTvId, guest.UserId);
        await SetMembersAsync(app, raphaelTvId);
        (await HasOptOutAsync(app, guest.UserId)).Should().BeTrue();

        await SetMembersAsync(app, raphaelTvId, guest.UserId);

        (await VisibleTvIdsAsync(app, guest.Login.AccessToken)).Should().Equal(raphaelTvId);
        (await HasOptOutAsync(app, guest.UserId)).Should().BeFalse("voltou a ser membro");
        using (var shortcuts = await app.GetAsync("/api/v1/tv/shortcuts", guest.Login.AccessToken))
        {
            shortcuts.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using (var notDefault = await app.GetAsync($"/api/v1/tv/shortcuts?tvId={defaultTvId}", guest.Login.AccessToken))
        {
            notDefault.StatusCode.Should().Be(HttpStatusCode.NotFound);
        }

        // Retirada de novo: a marca volta (uma linha por conta, sem duplicar).
        await SetMembersAsync(app, raphaelTvId);
        (await VisibleTvIdsAsync(app, guest.Login.AccessToken)).Should().BeEmpty();
        await using var db = app.Db();
        (await db.TvMemberOptOuts.CountAsync(o => o.UserId == guest.UserId, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ReplacingTheMembers_KeepsTheOnesThatStay_AndOnlyMarksWhoLostTheirLastTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var tvId = await CreateTvAsync(app, (await app.PairAsync("PC Raphael")).Slug, "TV Raphael");
        var stays = await app.NewGuestAsync("Fica", ["module:tv", "tv:control"], 92);
        var leaves = await app.NewGuestAsync("Sai", ["module:tv", "tv:control"], 93);
        var arrives = await app.NewGuestAsync("Chega", ["module:tv", "tv:control"], 94);
        await SetMembersAsync(app, tvId, stays.UserId, leaves.UserId);

        await SetMembersAsync(app, tvId, stays.UserId, arrives.UserId);

        await using var db = app.Db();
        (await db.TvMembers.Where(m => m.TvId == tvId).Select(m => m.UserId).ToListAsync(Ct)).Should().BeEquivalentTo([stays.UserId, arrives.UserId]);
        (await db.TvMemberOptOuts.Select(o => o.UserId).ToListAsync(Ct)).Should().Equal(leaves.UserId);
    }

    [Fact]
    public async Task ConcurrentRemovalsOfTwoMemberships_NeverLeaveTheAccountWithoutTheOptOut()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        await BindDefaultAsync(app);
        var firstTvId = await CreateTvAsync(app, (await app.PairAsync("PC Um")).Slug, "TV Um");
        var secondTvId = await CreateTvAsync(app, (await app.PairAsync("PC Dois")).Slug, "TV Dois");
        var guest = await app.NewGuestAsync("Dois lares", ["module:tv", "tv:control"], 95);
        await SetMembersAsync(app, firstTvId, guest.UserId);
        await SetMembersAsync(app, secondTvId, guest.UserId);

        // Segura o COMMIT de quem apaga uma filiação por meio segundo: as duas gravações se sobrepõem de forma
        // determinística, como numa máquina lenta, e cada transação só enxergaria a filiação que a outra está tirando.
        await app.ExecuteSqlAsync("""
            CREATE FUNCTION tv.hold_membership_commit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(0.5); RETURN NULL; END $$;
            CREATE CONSTRAINT TRIGGER hold_membership_commit AFTER DELETE ON tv.tv_members
                DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tv.hold_membership_commit();
            """);

        var first = app.SendAsync(HttpMethod.Put, $"/api/v1/tv/tvs/{firstTvId}/members", new { userIds = Array.Empty<Guid>() });
        var second = app.SendAsync(HttpMethod.Put, $"/api/v1/tv/tvs/{secondTvId}/members", new { userIds = Array.Empty<Guid>() });
        using var firstResponse = await first;
        using var secondResponse = await second;

        firstResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        secondResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        (await MembershipCountAsync(app, guest.UserId)).Should().Be(0);
        (await HasOptOutAsync(app, guest.UserId)).Should().BeTrue("sem filiação nenhuma e sem a marca, a conta cairia na TV padrão do dono");
        (await VisibleTvIdsAsync(app, guest.Login.AccessToken)).Should().BeEmpty();
    }
}
