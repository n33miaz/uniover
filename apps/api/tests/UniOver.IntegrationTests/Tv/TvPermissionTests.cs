using System.Net;
using System.Text.RegularExpressions;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// Cada rota da TV pela permissão dela: o administrador passa sempre, o convidado só com a concessão certa (lida do
/// banco, nunca do JWT) e toda recusa é o mesmo 403. Nada vai à TV de verdade: o agente é o falso e, nas chamadas que só
/// testam a porta, nem há agente (a rota que deixou passar responde 503/404/400 e a que barrou responde 403).
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed partial class TvPermissionTests(PostgresFixture postgres)
{
    /// <summary>O identificador da requisição é a única parte da recusa que muda de uma chamada para outra.</summary>
    [GeneratedRegex("\"traceId\":\"[^\"]*\"", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex TraceId();

    private const string KeysUrl = "/api/v1/tv/keys";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    // Conjuntos mínimos: cada um recebe o módulo e UMA permissão de ação, para provar que uma não empresta a outra.
    private static readonly string[] ModuleOnly = ["module:tv"];

    private static readonly string[] WithControl = ["module:tv", "tv:control"];

    private static readonly string[] WithPower = ["module:tv", "tv:power"];

    private static readonly string[] WithLaunch = ["module:tv", "tv:launch"];

    private static readonly string[] WithEditShortcuts = ["module:tv", "tv:edit-shortcuts"];

    private static readonly string[] WithHistory = ["module:tv", "tv:history"];

    private static readonly string[] ControlAndHistory = ["module:tv", "tv:control", "tv:history"];

    private static readonly string[] TrainingOnly = ["module:training"];

    /// <summary>O que a convidada que já existia recebeu na migração: a TV inteira, sem editar atalhos.</summary>
    private static readonly string[] TodayModel = ["module:tv", "tv:control", "tv:power", "tv:launch", "tv:history"];

    private static readonly (string Label, string[] Permissions)[] Sets =
    [
        ("So o modulo", ModuleOnly),
        ("Controle", WithControl),
        ("Desligar", WithPower),
        ("Abrir apps", WithLaunch),
        ("Editar atalhos", WithEditShortcuts),
        ("Historico", WithHistory),
        ("De hoje", TodayModel),
        ("So treino", TrainingOnly),
    ];

    private static readonly string[] ForgedPermissions = ["tv:control", "tv:power", "tv:launch", "tv:edit-shortcuts", "tv:history", "module:tv"];

    /// <summary>Chama a rota como a pessoa a chamaria (o fluxo ao vivo, só com o bilhete em cookie) e devolve o status e a "cara" da recusa.</summary>
    private static async Task<(HttpStatusCode Status, string Refusal)> CallAsync(TvApp app, TvRoute route, string? bearer, string? ticket)
    {
        if (route.IsStream)
        {
            using var stream = await app.OpenEventsAsync(ticket);
            return (stream.StatusCode, await RefusalAsync(stream));
        }

        using var response = await app.SendAsync(route.HttpMethod, route.Url(), route.Body, bearer);
        return (response.StatusCode, await RefusalAsync(response));
    }

    /// <summary>
    /// Tudo o que a pessoa vê numa recusa (status, tipo e corpo, menos o identificador da requisição): igual para qualquer
    /// rota e qualquer permissão que falte.
    /// </summary>
    private static async Task<string> RefusalAsync(HttpResponseMessage response)
    {
        if (response.StatusCode != HttpStatusCode.Forbidden)
        {
            return string.Empty;
        }

        var body = TraceId().Replace(await response.Content.ReadAsStringAsync(Ct), "\"traceId\":\"-\"");
        return $"{(int)response.StatusCode}|{response.Content.Headers.ContentType}|{body}";
    }

    private static async Task<HttpStatusCode> KeyStatusAsync(TvApp app, string bearer)
    {
        using var response = await app.SendAsync(HttpMethod.Post, KeysUrl, new { key = "HOME" }, bearer);
        return response.StatusCode;
    }

    /// <summary>O agente manda a lista de apps e o teste espera os atalhos existirem; devolve os ids na ordem de hoje.</summary>
    private static async Task<List<Guid>> SeedShortcutsAsync(TvApp app, FakeAgent agent, params (string Package, string? Label)[] apps)
    {
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(apps)));
        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.Shortcuts.CountAsync(Ct) == apps.Length;
        }, "atalhos criados");
        await using var read = app.Db();
        return await read.Shortcuts.OrderBy(s => s.Position).Select(s => s.Id).ToListAsync(Ct);
    }

    /// <summary>
    /// Prova de que nada mais chegou à TV: o dono manda uma tecla de controle e ela é a PRIMEIRA que o agente recebe (o que
    /// o convidado barrado tentou nunca saiu do servidor).
    /// </summary>
    private static async Task AssertNothingElseReachedTheTvAsync(TvApp app, FakeAgent agent)
    {
        var sentinel = app.SendAsync(HttpMethod.Post, KeysUrl, new { key = "MUTE" });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("body").GetProperty("key").GetString().Should().Be("MUTE", "o comando do convidado barrado não pode ter chegado antes");
        await TvApp.ReplyAsync(agent, command);
        (await Within(sentinel)).Dispose();
    }

    // ----- A matriz: rota x permissão -----

    [Fact]
    public async Task EachTvRoute_IsOpenExactlyToWhoHoldsItsPermission_AndEveryRefusalLooksTheSame()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var mistakes = new List<string>();
        var refusals = new HashSet<string>();
        var ip = 10;

        foreach (var (label, permissions) in Sets)
        {
            var guest = await app.NewGuestAsync(label, permissions, ip++);
            var ticket = await app.StreamTicketAsync(guest.Login.AccessToken);
            foreach (var route in TvPermissionMap.Routes)
            {
                var (status, refusal) = await CallAsync(app, route, guest.Login.AccessToken, ticket);
                var allowed = permissions.Contains(route.Permission);
                if (allowed != TvPermissionMap.Reached(status) || (!allowed && status != HttpStatusCode.Forbidden))
                {
                    mistakes.Add($"{label} em {route}: respondeu {(int)status} e {(allowed ? "devia passar" : "devia ser 403")}");
                }

                if (refusal.Length > 0)
                {
                    refusals.Add(refusal);
                }
            }
        }

        mistakes.Should().BeEmpty();
        refusals.Should().ContainSingle("toda recusa é o mesmo 403, sem dizer qual permissão falta nem se a rota existe");
    }

    [Fact]
    public async Task TheOwner_PassesEveryTvRoute_WithoutAnyGrantRow()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var ticket = await app.StreamTicketAsync();

        foreach (var route in TvPermissionMap.Routes)
        {
            var (status, _) = await CallAsync(app, route, app.Login.AccessToken, ticket);
            TvPermissionMap.Reached(status).Should().BeTrue($"{route} para o administrador (respondeu {(int)status})");
        }

        await using var db = app.Identity();
        (await db.UserGrants.CountAsync(Ct)).Should().Be(0, "o administrador tem tudo de forma implícita");
    }

    [Fact]
    public async Task Anonymous_GetsA401OnEveryTvRoute()
    {
        await using var app = await TvApp.StartAsync(postgres);

        foreach (var route in TvPermissionMap.Routes)
        {
            var (status, _) = await CallAsync(app, route, bearer: null, ticket: null);
            status.Should().Be(HttpStatusCode.Unauthorized, route.ToString());
        }
    }

    // ----- O que cada permissão faz de verdade (com o agente falso) -----

    [Fact]
    public async Task OnlyTheModule_SeesStateAndShortcuts_ButNoKeyEverGoesToTheTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var guest = await app.NewGuestAsync("So ver", ModuleOnly, 11);
        var token = guest.Login.AccessToken;

        using var state = await app.GetAsync("/api/v1/tv/state", bearer: token);
        using var shortcuts = await app.GetAsync("/api/v1/tv/shortcuts", bearer: token);
        using var key = await app.SendAsync(HttpMethod.Post, KeysUrl, new { key = "HOME" }, bearer: token);
        using var text = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/text", new { text = "filme" }, bearer: token);
        using var wake = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/wake", bearer: token);

        state.StatusCode.Should().Be(HttpStatusCode.OK);
        shortcuts.StatusCode.Should().Be(HttpStatusCode.OK);
        key.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        text.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        wake.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await AssertNothingElseReachedTheTvAsync(app, agent);
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(1, "só o comando do dono, que serviu de prova, foi registrado");
    }

    [Fact]
    public async Task Control_SendsKeysAndText_ButCannotPowerOffOpenAppsOrReadTheHistory()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var guest = await app.NewGuestAsync("Controle", WithControl, 12);
        var token = guest.Login.AccessToken;

        var key = app.SendAsync(HttpMethod.Post, KeysUrl, new { key = "VOLUME_UP" }, bearer: token);
        var keyCommand = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, keyCommand);
        using var keyResponse = await Within(key);
        var text = app.SendAsync(HttpMethod.Post, "/api/v1/tv/text", new { text = "filme" }, bearer: token);
        var textCommand = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, textCommand);
        using var textResponse = await Within(text);

        using var off = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/power/off", bearer: token);
        using var launch = await app.SendAsync(HttpMethod.Post, $"/api/v1/tv/shortcuts/{Guid.NewGuid()}/launch", bearer: token);
        using var refresh = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/shortcuts/refresh", bearer: token);
        using var history = await app.GetAsync("/api/v1/tv/commands/recent", bearer: token);

        keyResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        textResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        off.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        launch.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        refresh.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        history.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await AssertNothingElseReachedTheTvAsync(app, agent);
        await using var db = app.Db();
        var authors = await db.CommandAudit.Select(a => a.UserId).ToListAsync(Ct);
        authors.Count(id => id == guest.UserId).Should().Be(2, "só a tecla e o texto do convidado, ambos em nome dele");
    }

    [Fact]
    public async Task Power_TurnsTheTvOff_ButCannotSendKeys()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var guest = await app.NewGuestAsync("Desligar", WithPower, 13);
        var token = guest.Login.AccessToken;

        var off = app.SendAsync(HttpMethod.Post, "/api/v1/tv/power/off", bearer: token);
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("body").GetProperty("key").GetString().Should().Be("POWER");
        await TvApp.ReplyAsync(agent, command);
        using var offResponse = await Within(off);
        using var key = await app.SendAsync(HttpMethod.Post, KeysUrl, new { key = "HOME" }, bearer: token);

        offResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        key.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await AssertNothingElseReachedTheTvAsync(app, agent);
    }

    [Fact]
    public async Task Launch_OpensAnAppAndRefreshesTheList_ButCannotRenameOrSendKeys()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var ids = await SeedShortcutsAsync(app, agent, ("com.a.um", "Um"), ("com.b.dois", "Dois"));
        var guest = await app.NewGuestAsync("Abrir apps", WithLaunch, 14);
        var token = guest.Login.AccessToken;

        var launch = app.SendAsync(HttpMethod.Post, $"/api/v1/tv/shortcuts/{ids[0]}/launch", bearer: token);
        var launchCommand = await TvApp.NextCommandAsync(agent);
        launchCommand.GetProperty("type").GetString().Should().Be("tv.app.launch.v1");
        await TvApp.ReplyAsync(agent, launchCommand);
        using var launched = await Within(launch);
        var refresh = app.SendAsync(HttpMethod.Post, "/api/v1/tv/shortcuts/refresh", bearer: token);
        var refreshCommand = await TvApp.NextCommandAsync(agent);
        refreshCommand.GetProperty("type").GetString().Should().Be("tv.apps.refresh.v1");
        await TvApp.ReplyAsync(agent, refreshCommand);
        using var refreshed = await Within(refresh);

        using var rename = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{ids[0]}", new { customLabel = "Meu" }, bearer: token);
        using var key = await app.SendAsync(HttpMethod.Post, KeysUrl, new { key = "HOME" }, bearer: token);

        launched.StatusCode.Should().Be(HttpStatusCode.OK);
        refreshed.StatusCode.Should().Be(HttpStatusCode.OK);
        rename.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        key.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await AssertNothingElseReachedTheTvAsync(app, agent);
        await using var db = app.Db();
        (await db.Shortcuts.CountAsync(s => s.CustomLabel != null, Ct)).Should().Be(0, "o convidado não renomeou nada");
    }

    [Fact]
    public async Task EditShortcuts_RenamesHidesAndReorders_InHisName_ButCannotOpenAppsOrSendKeys()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var ids = await SeedShortcutsAsync(app, agent, ("com.a.um", "Um"), ("com.b.dois", "Dois"));
        var guest = await app.NewGuestAsync("Editar atalhos", WithEditShortcuts, 15);
        var token = guest.Login.AccessToken;

        using var reorder = await app.SendAsync(HttpMethod.Put, "/api/v1/tv/shortcuts/order", new { ids = new[] { ids[1], ids[0] } }, bearer: token);
        using var rename = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{ids[0]}", new { customLabel = "Meu app" }, bearer: token);
        using var hide = await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{ids[1]}", new { enabled = false }, bearer: token);
        using var launch = await app.SendAsync(HttpMethod.Post, $"/api/v1/tv/shortcuts/{ids[0]}/launch", bearer: token);
        using var key = await app.SendAsync(HttpMethod.Post, KeysUrl, new { key = "HOME" }, bearer: token);

        rename.StatusCode.Should().Be(HttpStatusCode.OK);
        hide.StatusCode.Should().Be(HttpStatusCode.OK);
        reorder.StatusCode.Should().Be(HttpStatusCode.OK);
        launch.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        key.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await AssertNothingElseReachedTheTvAsync(app, agent);
        await using var db = app.Db();
        var shortcuts = await db.Shortcuts.AsNoTracking().OrderBy(s => s.Position).ToListAsync(Ct);
        shortcuts.Select(s => s.Id).Should().Equal(ids[1], ids[0]);
        shortcuts.Single(s => s.Id == ids[0]).CustomLabel.Should().Be("Meu app");
        shortcuts.Single(s => s.Id == ids[1]).Enabled.Should().BeFalse();

        // A auditoria da reordenação segue como estava: grava QUEM mandou, e agora esse alguém pode ser o convidado.
        (await db.CommandAudit.Where(a => a.Command == "tv.shortcuts.reorder").Select(a => a.UserId).SingleAsync(Ct)).Should().Be(guest.UserId);
    }

    [Fact]
    public async Task History_ShowsOnlyTheGuestsOwnCommands_AndWithoutThePermissionIsRefused()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var reader = await app.NewGuestAsync("Historico", ControlAndHistory, 16);
        var blind = await app.NewGuestAsync("Sem historico", WithControl, 17);

        async Task SendAsync(string? bearer, string key)
        {
            var request = app.SendAsync(HttpMethod.Post, KeysUrl, new { key }, bearer: bearer);
            var command = await TvApp.NextCommandAsync(agent);
            await TvApp.ReplyAsync(agent, command);
            (await Within(request)).Dispose();
        }

        await SendAsync(string.Empty, "HOME");
        await SendAsync(reader.Login.AccessToken, "MUTE");
        await SendAsync(blind.Login.AccessToken, "BACK");

        using var asReader = await app.GetAsync("/api/v1/tv/commands/recent", bearer: reader.Login.AccessToken);
        using var asBlind = await app.GetAsync("/api/v1/tv/commands/recent", bearer: blind.Login.AccessToken);
        using var asOwner = await app.GetAsync("/api/v1/tv/commands/recent");

        asReader.StatusCode.Should().Be(HttpStatusCode.OK);
        var rows = (await TvApp.JsonAsync(asReader)).EnumerateArray().ToList();
        rows.Select(r => r.GetProperty("detail").GetString()).Should().Equal("MUTE");
        rows.Should().OnlyContain(r => r.GetProperty("byMe").GetBoolean());
        asBlind.StatusCode.Should().Be(HttpStatusCode.Forbidden, "mandar teclas não dá o histórico");
        (await TvApp.JsonAsync(asOwner)).GetArrayLength().Should().Be(3, "o administrador continua vendo o de todos");
    }

    // ----- Recusas que não dependem das concessões -----

    [Fact]
    public async Task ARevokedGuest_IsRefusedOnEveryTvRoute_AtOnce_AndTheOwnerIsNot()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("Revogada", null, 18);
        var token = guest.Login.AccessToken;
        var ticket = await app.StreamTicketAsync(token);
        using (var warm = await app.GetAsync("/api/v1/tv/state", bearer: token))
        {
            warm.StatusCode.Should().Be(HttpStatusCode.OK, "o cache já tem a conta");
        }

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke");

        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        foreach (var route in TvPermissionMap.Routes)
        {
            var (status, _) = await CallAsync(app, route, token, ticket);
            status.Should().Be(HttpStatusCode.Forbidden, $"{route} depois da revogação, com o JWT ainda válido");
        }

        using var owner = await app.GetAsync("/api/v1/tv/state");
        owner.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task PermissionClaimsForgedIntoAValidJwt_AreIgnoredOnTheTvRoutes()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("So ver", ModuleOnly, 19);
        var now = app.Time.GetUtcNow();
        var forged = IdentityApp.CraftToken(
            app.SigningKey,
            now.AddMinutes(-1),
            now.AddHours(1),
            subject: guest.UserId,
            role: AccountRoles.Guest,
            extraClaims: new Dictionary<string, object>
            {
                ["permissions"] = ForgedPermissions,
                ["permission"] = "tv:control",
                ["scope"] = "tv:control tv:power module:tv",
            });

        foreach (var route in TvPermissionMap.Routes.Where(r => !r.IsStream))
        {
            using var response = await app.SendAsync(route.HttpMethod, route.Url(), route.Body, forged);
            var allowed = route.Permission == "module:tv";
            (response.StatusCode == HttpStatusCode.Forbidden).Should().Be(!allowed, $"{route}: só o que está no banco conta");
        }
    }

    [Fact]
    public async Task AnActionGrantWithoutTheModule_OpensNothingOnTheTv_EvenIfTheTableWasEditedByHand()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("Controle", WithControl, 20);
        var token = guest.Login.AccessToken;
        (await KeyStatusAsync(app, token)).Should().NotBe(HttpStatusCode.Forbidden);

        await app.ExecuteSqlAsync($"DELETE FROM identity.user_grants WHERE user_id = '{guest.UserId}' AND permission = 'module:tv'");
        app.Time.Advance(TimeSpan.FromSeconds(31));

        (await KeyStatusAsync(app, token)).Should().Be(HttpStatusCode.Forbidden, "tv:control sem module:tv não vale");
        using var state = await app.GetAsync("/api/v1/tv/state", bearer: token);
        state.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ----- Mudança de permissão -----

    [Fact]
    public async Task AChangeMadeThroughTheApi_TakesEffectAtOnce_WithTheSameJwt_InBothDirections()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        var guest = await app.NewGuestAsync("Controle", WithControl, 21);
        var token = guest.Login.AccessToken;
        (await KeyStatusAsync(app, token)).Should().NotBe(HttpStatusCode.Forbidden, "o cache já tem a conta com a permissão");
        using (var offBefore = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/power/off", bearer: token))
        {
            offBefore.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }

        // Tira o controle e dá o desligar: ambos valem na hora, sem esperar o prazo do cache.
        (await app.ChangeGuestPermissionsAsync(authenticator, guest.UserId, WithPower)).Should().Be(HttpStatusCode.OK);

        (await KeyStatusAsync(app, token)).Should().Be(HttpStatusCode.Forbidden, "a permissão foi retirada e o cache esquecido");
        using var offAfter = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/power/off", bearer: token);
        TvPermissionMap.Reached(offAfter.StatusCode).Should().BeTrue("a permissão nova vale sem esperar");
    }

    [Fact]
    public async Task AChangeMadeBehindTheCache_IsSeenWithin30Seconds_NotBefore()
    {
        // Simula outra instância: o banco muda sem passar pela invalidação desta.
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("Controle", WithControl, 22);
        var token = guest.Login.AccessToken;
        (await KeyStatusAsync(app, token)).Should().NotBe(HttpStatusCode.Forbidden);

        await app.ExecuteSqlAsync($"DELETE FROM identity.user_grants WHERE user_id = '{guest.UserId}' AND permission = 'tv:control'");
        await app.ExecuteSqlAsync(
            $"INSERT INTO identity.user_grants (user_id, permission, granted_by, granted_at) VALUES ('{guest.UserId}', 'tv:power', '{guest.UserId}', now())");

        app.Time.Advance(TimeSpan.FromSeconds(29));
        (await KeyStatusAsync(app, token)).Should().NotBe(HttpStatusCode.Forbidden, "dentro do prazo vale a resposta guardada");
        using (var offEarly = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/power/off", bearer: token))
        {
            offEarly.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }

        app.Time.Advance(TimeSpan.FromSeconds(2));
        (await KeyStatusAsync(app, token)).Should().Be(HttpStatusCode.Forbidden, "passados 30 s o banco é lido de novo");
        using var offLate = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/power/off", bearer: token);
        TvPermissionMap.Reached(offLate.StatusCode).Should().BeTrue();
    }

    [Fact]
    public async Task ATrainingOnlyGuest_ReachesNothingOfTheTv_AndTheTvOnlyGuestNothingOfTraining()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var training = await app.NewGuestAsync("Raphael", TrainingOnly, 23);
        var tv = await app.NewGuestAsync("So TV", ModuleOnly, 24);

        foreach (var route in TvPermissionMap.Routes.Where(r => !r.IsStream))
        {
            using var response = await app.SendAsync(route.HttpMethod, route.Url(), route.Body, training.Login.AccessToken);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"{route} para quem só tem o Treino");
        }

        using var exercises = await app.GetAsync("/api/v1/training/exercises", bearer: tv.Login.AccessToken);
        exercises.StatusCode.Should().Be(HttpStatusCode.Forbidden, "a TV não abre o Treino");
    }
}
