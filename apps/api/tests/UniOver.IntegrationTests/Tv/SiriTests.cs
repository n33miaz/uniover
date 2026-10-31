using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv;
using UniOver.Modules.Tv.Domain;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// A chave dos Atalhos do iPhone: criada pelo administrador (com a passkey), mostrada uma vez, guardada só como hash, com
/// escopo de ações e de TV, revogável, com validade, auditada e limitada por IP. O agente falso recebe o contrato de
/// verdade, então uma ação fora do escopo aparece como ausência de comando.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class SiriTests(PostgresFixture postgres)
{
    private const string TokensUrl = "/api/v1/tv/siri/tokens";
    private const string TriggerUrl = "/api/v1/shortcuts/tv";

    private static readonly string[] DefaultActions = ["volume_up", "power_off", "key:HOME"];
    private static readonly string[] VolumeOnly = ["volume_up"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    private sealed record Setup(Guid OwnerId, Guid TvId, Guid AppId, VirtualAuthenticator Authenticator);

    /// <summary>O dono com passkey, uma TV salva (a do agente falso) e um app instalado nela.</summary>
    private static async Task<Setup> SetUpAsync(TvApp app)
    {
        var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);

        await using var identity = app.Identity();
        var owner = await identity.Users.SingleAsync(u => u.Email == app.OwnerEmail, Ct);

        await using var db = app.Db();
        var tv = ConfiguredTv.CreateDefault("TV da sala", app.Agent.Slug, owner.Id, app.Time.GetUtcNow());
        db.Tvs.Add(tv);
        var shortcut = Shortcut.Create(tv.Id, "com.exemplo.video", "Vídeo", 1, app.Time.GetUtcNow());
        db.Shortcuts.Add(shortcut);
        await db.SaveChangesAsync(Ct);
        return new Setup(owner.Id, tv.Id, shortcut.Id, authenticator);
    }

    private static async Task<HttpResponseMessage> CreateAsync(
        TvApp app, Setup setup, object? body = null, bool confirm = true, string? bearer = "")
    {
        if (confirm)
        {
            await app.ConfirmOwnerActionAsync(setup.Authenticator, TvAuth.SiriTokenAction);
        }

        return await app.SendAsync(
            HttpMethod.Post, TokensUrl,
            body ?? new { name = "iPhone do dono", tvId = setup.TvId, actions = DefaultActions },
            bearer: bearer);
    }

    private static async Task<string> NewTokenAsync(TvApp app, Setup setup, object? body = null)
    {
        using var response = await CreateAsync(app, setup, body);
        response.StatusCode.Should().Be(HttpStatusCode.Created);
        return (await TvApp.JsonAsync(response)).GetProperty("token").GetString()!;
    }

    private static Task<HttpResponseMessage> TriggerAsync(TvApp app, string? token, object? body, string? forwardedFor = TvApp.ClientIp)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, TriggerUrl) { Content = body is null ? null : JsonContent.Create(body) };
        if (token is not null)
        {
            request.Headers.Add("X-Atalho-Token", token);
        }

        if (forwardedFor is not null)
        {
            request.Headers.Add("X-Forwarded-For", forwardedFor);
        }

        request.Headers.TryAddWithoutValidation("User-Agent", "Shortcuts/1300 CFNetwork/1568 Darwin/24.0");
        return app.Client.SendAsync(request, Ct);
    }

    private static async Task DeclarePowerOffAsync(TvApp app, FakeAgent agent)
    {
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.kind.android", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(
            () => app.Presence.Get(TvApp.AgentSlug)?.Capabilities.Contains("tv.power.off.v1") == true, "capacidades do agente");
    }

    // ---- criar, mostrar uma vez, guardar só o hash ----

    [Fact]
    public async Task Create_WithoutThePasskeyConfirmation_Returns403_AndNothingIsStored()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);

        using var response = await CreateAsync(app, setup, confirm: false);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.SiriTokens.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Create_ShowsTheSecretOnce_AndTheDatabaseKeepsOnlyItsHash()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);

        using var response = await CreateAsync(app, setup);

        response.StatusCode.Should().Be(HttpStatusCode.Created);
        var created = await TvApp.JsonAsync(response);
        var token = created.GetProperty("token").GetString()!;
        token.Should().StartWith(SiriSecrets.Prefix);
        created.GetProperty("actions").EnumerateArray().Select(a => a.GetString()).Should().Equal("volume_up", "power_off", "key:HOME");

        await using var db = app.Db();
        var row = await db.SiriTokens.AsNoTracking().SingleAsync(Ct);
        row.TokenHash.Should().Equal(SiriSecrets.Hash(token));
        row.UserId.Should().Be(setup.OwnerId);
        row.TvId.Should().Be(setup.TvId);
        row.ExpiresAt.Should().BeNull();

        // Nenhuma coluna de texto do banco guarda o segredo (nem pedaço dele).
        var secretPart = token[SiriSecrets.Prefix.Length..];
        var texts = $"{row.Name} {string.Join(' ', row.Actions)}";
        texts.Should().NotContain(secretPart);

        // A lista nunca devolve o segredo, nem o hash.
        using var list = await app.GetAsync(TokensUrl);
        list.StatusCode.Should().Be(HttpStatusCode.OK);
        var raw = await list.Content.ReadAsStringAsync(Ct);
        raw.Should().NotContain(secretPart).And.NotContainEquivalentOf("token");
        var item = JsonDocument.Parse(raw).RootElement.GetProperty("items").EnumerateArray().Single();
        item.GetProperty("name").GetString().Should().Be("iPhone do dono");
        item.GetProperty("tvName").GetString().Should().Be("TV da sala");
    }

    [Fact]
    public async Task Create_IsAudited_WithTheOwner_AndNeverWithTheSecret()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);

        var token = await NewTokenAsync(app, setup);

        await using var db = app.Db();
        var row = await db.CommandAudit.AsNoTracking().SingleAsync(a => a.Command == TvCommandNames.SiriTokenCreate, Ct);
        row.UserId.Should().Be(setup.OwnerId);
        row.TvId.Should().Be(setup.TvId);
        row.Ok.Should().BeTrue();
        row.Detail.Should().Be("iPhone do dono");
        (row.Detail + row.UserAgent + row.Ip).Should().NotContain(token);
    }

    public static TheoryData<string> InvalidCreations => new()
    {
        """{"name":"","tvId":"TV","actions":["volume_up"]}""",
        """{"name":"x","tvId":"TV","actions":[]}""",
        """{"name":"x","tvId":"TV","actions":["volume_up","ligar"]}""",
        """{"name":"x","tvId":"TV","actions":["key:POWER"]}""",
        """{"name":"x","tvId":"TV","actions":["POWER"]}""",
        """{"name":"x","tvId":"TV","actions":["key:"]}""",
        """{"name":"x","tvId":"TV","actions":["app:not-a-guid"]}""",
        """{"name":"x","tvId":"TV","actions":["app:00000000-0000-0000-0000-000000000001"]}""",
        """{"name":"x","tvId":"TV","actions":["volume_up"],"expiresInDays":0}""",
        """{"name":"x","tvId":"TV","actions":["volume_up"],"expiresInDays":366}""",
        """{"name":"a‮b","tvId":"TV","actions":["volume_up"]}""",
        """{"name":"nome comprido demais para uma chave de atalho","tvId":"TV","actions":["volume_up"]}""",
        """{"name":"x","actions":["volume_up"]}""",
    };

    [Theory]
    [MemberData(nameof(InvalidCreations))]
    public async Task Create_WithAnInvalidBody_Returns400_AndStoresNothing(string json)
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var body = JsonSerializer.Deserialize<JsonElement>(json.Replace("\"TV\"", $"\"{setup.TvId}\"", StringComparison.Ordinal));

        using var response = await CreateAsync(app, setup, body);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.SiriTokens.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Create_WithAnAppOfAnotherTv_IsRefused()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        Guid otherApp;
        await using (var db = app.Db())
        {
            var other = ConfiguredTv.Create("Outra", "pc-outro", isDefault: false, setup.OwnerId, app.Time.GetUtcNow());
            db.Tvs.Add(other);
            var shortcut = Shortcut.Create(other.Id, "com.exemplo.outro", "Outro", 1, app.Time.GetUtcNow());
            db.Shortcuts.Add(shortcut);
            await db.SaveChangesAsync(Ct);
            otherApp = shortcut.Id;
        }

        using var response = await CreateAsync(app, setup, new { name = "x", tvId = setup.TvId, actions = new[] { $"app:{otherApp}" } });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Create_ForATvThatDoesNotExist_Returns404()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);

        using var response = await CreateAsync(app, setup, new { name = "x", tvId = Guid.NewGuid(), actions = VolumeOnly });

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Create_NormalizesTheActions_AndCapsTheActiveKeys()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);

        using var first = await CreateAsync(app, setup, new
        {
            name = "  iPhone  ", tvId = setup.TvId, actions = new[] { "volume_up", "volume_up", $"app:{setup.AppId.ToString().ToUpperInvariant()}" },
        });
        first.StatusCode.Should().Be(HttpStatusCode.Created);
        var body = await TvApp.JsonAsync(first);
        body.GetProperty("name").GetString().Should().Be("iPhone");
        body.GetProperty("actions").EnumerateArray().Select(a => a.GetString()).Should().Equal("volume_up", $"app:{setup.AppId}");

        for (var i = 1; i < SiriToken.MaxActivePerUser; i++)
        {
            await NewTokenAsync(app, setup);
        }

        using var tooMany = await CreateAsync(app, setup);
        tooMany.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    // ---- usar: o que passa e o que nunca passa ----

    [Fact]
    public async Task Volume_IsSentToTheAgentAsAKey_AnswersWithAShortMessage_AndIsAuditedAsSiri()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = TriggerAsync(app, token, new { tv = setup.TvId, action = "volume_up" });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.key.v2");
        command.GetProperty("body").GetRawText().Should().Be("{\"key\":\"VOLUME_UP\"}");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await TvApp.JsonAsync(response);
        body.GetProperty("ok").GetBoolean().Should().BeTrue();
        body.GetProperty("message").GetString().Should().Be("Volume aumentado.");

        await using var db = app.Db();
        var row = await db.CommandAudit.AsNoTracking().SingleAsync(a => a.Command == TvCommandNames.Key, Ct);
        row.UserId.Should().Be(setup.OwnerId, "a ordem sai na trilha com o nome de quem criou a chave");
        row.Detail.Should().Be("VOLUME_UP via=siri");
        row.TvId.Should().Be(setup.TvId);
        row.Ip.Should().Be(TvApp.ClientIp);
        row.UserAgent.Should().StartWith("Shortcuts/");
        row.Ok.Should().BeTrue();

        var token0 = await db.SiriTokens.AsNoTracking().SingleAsync(Ct);
        token0.LastUsedAt.Should().NotBeNull();
    }

    [Fact]
    public async Task TheTvInTheBodyIsOptional_ButWhenSentItMustBeTheKeysTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup);
        await using var agent = await app.ConnectAndWaitAsync();

        using var other = await TriggerAsync(app, token, new { tv = Guid.NewGuid(), action = "volume_up" });
        other.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var request = TriggerAsync(app, token, new { action = "volume_up" });
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command);
        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        await using var db = app.Db();
        var denied = await db.CommandAudit.AsNoTracking().SingleAsync(a => a.Command == TvCommandNames.SiriDenied, Ct);
        denied.Ok.Should().BeFalse();
        denied.ErrorCode.Should().Be("other_tv");
        denied.UserId.Should().Be(setup.OwnerId);
    }

    [Fact]
    public async Task APressedKeyAndTheOtherActionsOfTheScope_WorkWithTheirOwnMessage()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup);
        await using var agent = await app.ConnectAndWaitAsync();

        var request = TriggerAsync(app, token, new { tv = setup.TvId, action = "key", key = "HOME" });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("body").GetRawText().Should().Be("{\"key\":\"HOME\"}");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("message").GetString().Should().Be("Tecla enviada.");
    }

    [Fact]
    public async Task PowerOff_UsesTheSafeShutdown_AndAnswersThatTheTvWasTurnedOff()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup);
        await using var agent = await app.ConnectAndWaitAsync();
        await DeclarePowerOffAsync(app, agent);

        var request = TriggerAsync(app, token, new { tv = setup.TvId, action = "power_off" });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.power.off.v1");
        await TvApp.ReplyAsync(agent, command);

        using var response = await Within(request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("message").GetString().Should().Be("TV desligada.");
        await using var db = app.Db();
        (await db.CommandAudit.AsNoTracking().SingleAsync(a => a.Command == TvCommandNames.PowerOff, Ct)).Detail.Should().Be("POWER via=siri");
    }

    [Fact]
    public async Task PowerOff_ToAnAgentThatCannotReadThePower_SendsNothing_BecauseThePowerKeyCouldTurnTheTvOn()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.kind.android");

        using var response = await Within(TriggerAsync(app, token, new { tv = setup.TvId, action = "power_off" }));

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await TvApp.JsonAsync(response)).GetProperty("agentError").GetString().Should().Be("power_off_unsafe");
    }

    [Fact]
    public async Task OpeningAnApp_UsesThePackageOfTheTvList_AndAnUninstalledAppIs409()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup, new { name = "apps", tvId = setup.TvId, actions = new[] { $"app:{setup.AppId}" } });
        await using var agent = await app.ConnectAndWaitAsync();

        var request = TriggerAsync(app, token, new { tv = setup.TvId, action = "app", app = setup.AppId });
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.app.launch.v1");
        command.GetProperty("body").GetProperty("target").GetProperty("value").GetString().Should().Be("com.exemplo.video");
        await TvApp.ReplyAsync(agent, command);
        using var launched = await Within(request);
        launched.StatusCode.Should().Be(HttpStatusCode.OK);

        await using (var db = app.Db())
        {
            await db.Shortcuts.Where(s => s.Id == setup.AppId).ExecuteUpdateAsync(set => set.SetProperty(s => s.Installed, false), Ct);
        }

        using var gone = await Within(TriggerAsync(app, token, new { tv = setup.TvId, action = "app", app = setup.AppId }));
        gone.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Theory]
    [InlineData("""{"action":"key","key":"POWER"}""")]
    [InlineData("""{"action":"key","key":"VOLUME_UP"}""")]
    [InlineData("""{"action":"key"}""")]
    [InlineData("""{"action":"volume_up","key":"HOME"}""")]
    [InlineData("""{"action":"app","app":"não é id"}""")]
    [InlineData("""{"action":"ligar"}""")]
    [InlineData("""{"action":"wake"}""")]
    [InlineData("""{}""")]
    public async Task AnInvalidAction_Returns400_AndNothingGoesToTheAgent(string json)
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup);
        await using var agent = await app.ConnectAndWaitAsync();

        using var response = await TriggerAsync(app, token, JsonSerializer.Deserialize<JsonElement>(json));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(a => a.Command != TvCommandNames.SiriTokenCreate, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task AValidActionOutsideTheKeysScope_Returns403_IsAuditedAsDenied_AndNothingGoesToTheAgent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup, new { name = "só volume", tvId = setup.TvId, actions = VolumeOnly });
        await using var agent = await app.ConnectAndWaitAsync();

        foreach (var body in new object[]
        {
            new { tv = setup.TvId, action = "volume_down" },
            new { tv = setup.TvId, action = "power_off" },
            new { tv = setup.TvId, action = "key", key = "HOME" },
            new { tv = setup.TvId, action = "app", app = setup.AppId },
        })
        {
            using var response = await TriggerAsync(app, token, body);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }

        await using var db = app.Db();
        var denied = await db.CommandAudit.AsNoTracking().Where(a => a.Command == TvCommandNames.SiriDenied).ToListAsync(Ct);
        denied.Should().HaveCount(4).And.OnlyContain(a => a.ErrorCode == "out_of_scope" && !a.Ok && a.UserId == setup.OwnerId);
        denied.Select(a => a.Detail).Should().BeEquivalentTo("volume_down", "power_off", "key:HOME", $"app:{setup.AppId}");
        (await db.CommandAudit.CountAsync(a => a.Command == TvCommandNames.Key || a.Command == TvCommandNames.PowerOff, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task TheKey_DoesNotOpenAnyOtherRouteOfTheApi()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup);

        foreach (var (method, url) in new[]
        {
            (HttpMethod.Get, "/api/v1/tv/state"),
            (HttpMethod.Post, "/api/v1/tv/keys"),
            (HttpMethod.Post, "/api/v1/tv/power/off"),
            (HttpMethod.Get, TokensUrl),
            (HttpMethod.Get, "/api/v1/identity/me"),
        })
        {
            // Nem no cabeçalho próprio, nem no Authorization: a chave não é uma sessão.
            using var viaHeader = new HttpRequestMessage(method, url);
            viaHeader.Headers.Add("X-Atalho-Token", token);
            using var first = await app.Client.SendAsync(viaHeader, Ct);
            first.StatusCode.Should().Be(HttpStatusCode.Unauthorized, $"{method} {url} com a chave no cabeçalho do atalho");

            using var viaBearer = new HttpRequestMessage(method, url);
            viaBearer.Headers.Authorization = new("Bearer", token);
            using var second = await app.Client.SendAsync(viaBearer, Ct);
            second.StatusCode.Should().Be(HttpStatusCode.Unauthorized, $"{method} {url} com a chave como Bearer");
        }
    }

    [Fact]
    public async Task ASessionJwtIsNotAKey_AndAKeyIsNotASession()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);

        using var withJwt = await TriggerAsync(app, app.Login.AccessToken, new { tv = setup.TvId, action = "volume_up" });

        withJwt.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // ---- credencial: ausente, falsa, revogada, vencida ----

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("lixo")]
    [InlineData("atalho_")]
    [InlineData("atalho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("uo_dev_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    public async Task AMissingOrUnknownKey_Returns401_WithoutAuditOrCommand(string? token)
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();

        using var response = await TriggerAsync(app, token, new { tv = setup.TvId, action = "volume_up" });

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0, "sem conta reconhecida não há de quem registrar");
    }

    [Fact]
    public async Task ARevokedKey_StopsWorkingAtOnce_IsAudited_AndLeavesTheList()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup);
        await using var agent = await app.ConnectAndWaitAsync();
        Guid id;
        await using (var db = app.Db())
        {
            id = (await db.SiriTokens.AsNoTracking().SingleAsync(Ct)).Id;
        }

        using var revoke = await app.SendAsync(HttpMethod.Delete, $"{TokensUrl}/{id}");
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        using var again = await app.SendAsync(HttpMethod.Delete, $"{TokensUrl}/{id}");
        again.StatusCode.Should().Be(HttpStatusCode.NoContent, "revogar de novo é inofensivo");

        using var response = await TriggerAsync(app, token, new { tv = setup.TvId, action = "volume_up" });
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        using var list = await app.GetAsync(TokensUrl);
        (await TvApp.JsonAsync(list)).GetProperty("items").GetArrayLength().Should().Be(0);

        await using var db2 = app.Db();
        var row = await db2.CommandAudit.AsNoTracking().SingleAsync(a => a.Command == TvCommandNames.SiriTokenRevoke, Ct);
        row.UserId.Should().Be(setup.OwnerId);
        row.Detail.Should().Be("iPhone do dono");
        (await db2.CommandAudit.CountAsync(a => a.Command == TvCommandNames.SiriTokenRevoke, Ct)).Should().Be(1, "só a primeira revogação deixa rastro");
        (await db2.SiriTokens.AsNoTracking().SingleAsync(Ct)).RevokedAt.Should().NotBeNull();
    }

    [Fact]
    public async Task RevokingAKeyThatDoesNotExist_Returns404()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await SetUpAsync(app);

        using var response = await app.SendAsync(HttpMethod.Delete, $"{TokensUrl}/{Guid.NewGuid()}");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task AKeyWithAnExpiry_StopsWorkingWhenItPasses()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup, new { name = "30 dias", tvId = setup.TvId, actions = VolumeOnly, expiresInDays = 30 });
        await using var agent = await app.ConnectAndWaitAsync();

        await using (var db = app.Db())
        {
            (await db.SiriTokens.AsNoTracking().SingleAsync(Ct)).ExpiresAt.Should().Be(app.Time.GetUtcNow().AddDays(30));
        }

        var request = TriggerAsync(app, token, new { tv = setup.TvId, action = "volume_up" });
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command);
        using var inTime = await Within(request);
        inTime.StatusCode.Should().Be(HttpStatusCode.OK);

        app.Time.Advance(TimeSpan.FromDays(30) + TimeSpan.FromSeconds(1));

        using var expired = await TriggerAsync(app, token, new { tv = setup.TvId, action = "volume_up" });
        expired.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        using var list = await app.GetAsync(TokensUrl, bearer: await RefreshedBearerAsync(app));
        (await TvApp.JsonAsync(list)).GetProperty("items").GetArrayLength().Should().Be(0, "a chave vencida sai da lista");
    }

    /// <summary>O relógio falso andou 30 dias: o JWT do dono venceu, então entra de novo.</summary>
    private static async Task<string> RefreshedBearerAsync(TvApp app)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/login")
        {
            Content = JsonContent.Create(new { email = app.OwnerEmail, password = app.OwnerPassword }),
        };
        request.Headers.Add(UniOver.IntegrationTests.Identity.IdentityApp.ClientHeader, "web");
        using var response = await app.Client.SendAsync(request, Ct);
        response.EnsureSuccessStatusCode();
        return (await TvApp.JsonAsync(response)).GetProperty("accessToken").GetString()!;
    }

    // ---- a conta continua mandando mais que a chave ----

    [Fact]
    public async Task AKeyOfAnAccountThatLostThePermission_IsDenied_ForThatActionOnly()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var guest = await app.NewGuestAsync("só controle", ["module:tv", "tv:control"], ipSuffix: 71);

        // A API só cria chave para o administrador; este convidado ganhou uma por fora para provar a conferência a cada uso.
        var (secret, hash) = SiriSecrets.New();
        await using (var db = app.Db())
        {
            db.SiriTokens.Add(SiriToken.Create(
                guest.UserId, setup.TvId, "convidado", hash, ["power_off", "volume_up"], app.Time.GetUtcNow(), expiresAt: null));
            await db.SaveChangesAsync(Ct);
        }

        await using var agent = await app.ConnectAndWaitAsync();

        using var power = await TriggerAsync(app, secret, new { tv = setup.TvId, action = "power_off" });
        power.StatusCode.Should().Be(HttpStatusCode.Forbidden, "ele não tem tv:power, mesmo com a ação na chave");

        await using var check = app.Db();
        var denied = await check.CommandAudit.AsNoTracking().SingleAsync(a => a.Command == TvCommandNames.SiriDenied, Ct);
        denied.ErrorCode.Should().Be("permission_lost");
        denied.UserId.Should().Be(guest.UserId);

        var request = TriggerAsync(app, secret, new { tv = setup.TvId, action = "volume_up" });
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command);
        using var volume = await Within(request);
        volume.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AKeyOfARevokedAccount_StopsWorking()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var guest = await app.NewGuestAsync("saiu", ["module:tv", "tv:control"], ipSuffix: 72);
        var (secret, hash) = SiriSecrets.New();
        await using (var db = app.Db())
        {
            db.SiriTokens.Add(SiriToken.Create(guest.UserId, setup.TvId, "convidado", hash, ["volume_up"], app.Time.GetUtcNow(), expiresAt: null));
            await db.SaveChangesAsync(Ct);
        }

        await using (var identity = app.Identity())
        {
            await identity.Users.Where(u => u.Id == guest.UserId)
                .ExecuteUpdateAsync(set => set.SetProperty(u => u.DisabledAt, app.Time.GetUtcNow()), Ct);
        }

        // O cache curto da conta vale por até 30 segundos.
        app.Time.Advance(TimeSpan.FromMinutes(2));

        using var response = await TriggerAsync(app, secret, new { tv = setup.TvId, action = "volume_up" });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task ATvDeletedAfterTheKeyWasCreated_Returns404()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var setup = await SetUpAsync(app);
        var token = await NewTokenAsync(app, setup);
        await using (var db = app.Db())
        {
            await db.Tvs.Where(t => t.Id == setup.TvId).ExecuteDeleteAsync(Ct);
        }

        using var response = await TriggerAsync(app, token, new { tv = setup.TvId, action = "volume_up" });

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- limite ----

    [Fact]
    public async Task TheTriggerRoute_IsLimitedByIp_AndCountsTheWrongKeysToo()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { SiriPermitted = 3 });

        for (var i = 0; i < 3; i++)
        {
            using var wrong = await TriggerAsync(app, "atalho_errada", new { action = "volume_up" });
            wrong.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        }

        using var limited = await TriggerAsync(app, "atalho_errada", new { action = "volume_up" });
        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        limited.Headers.Contains("Retry-After").Should().BeTrue();

        // Outro IP tem balde próprio.
        using var other = await TriggerAsync(app, "atalho_errada", new { action = "volume_up" }, forwardedFor: "198.51.100.77");
        other.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
