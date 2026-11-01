using System.Diagnostics.CodeAnalysis;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Features.TvLivre;
using UniOver.Modules.Tv.Ports;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// O TV Livre de ponta a ponta com o agente falso: a tela montada do estado, a configuração e a foto guardadas, cada passo
/// no aparelho (mensagem, tempo próprio, auditoria), a foto em pedaços antes do <c>apply</c>, a revisão que só cresce, o
/// módulo que só existe para quem anuncia a capacidade e a porta fechada para quem não é o dono.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TvLivreTests(PostgresFixture postgres)
{
    private const string Capability = "tv.livre.v1";
    private const string Base = "/api/v1/tv/livre";

    private static readonly string[] BadPackage = ["nome ruim"];
    private static readonly string[] SamePackage = ["com.a.b"];
    private static readonly string[] ToDisable = ["com.fabrica.loja"];
    private static readonly string[] ToEnable = ["com.fabrica.tv"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    /// <summary>Um agente conectado que anuncia (ou não) o TV Livre, já com a presença conhecida pela API.</summary>
    private static async Task<FakeAgent> ConnectAsync(TvApp app, bool withCapability = true)
    {
        var agent = await app.ConnectAsync();
        await (withCapability
            ? agent.SendHelloAsync("2.0.0", "tv.remote", Capability)
            : agent.SendHelloAsync("2.0.0", "tv.remote"));
        // Quem reconecta depois de outro hello não pode confiar em "tv.remote": a presença antiga ainda o tem. Por isso
        // com a capacidade espera por ela, e sem ela só vale a primeira conexão do teste.
        await TvApp.WaitUntilAsync(
            () => app.Presence.Get(TvApp.AgentSlug) is { Connected: true } info
                && info.Capabilities.Contains(withCapability ? Capability : "tv.remote"),
            "agente conectado com o hello");
        return agent;
    }

    private static JsonObject StateBody(
        JsonElement command, bool installed = false, bool isHome = false, string? version = null, string? factory = null,
        string[]? disabled = null, (string Package, bool Factory, bool Disabled)[]? apps = null)
    {
        var body = new JsonObject
        {
            ["requestId"] = command.GetProperty("body").GetProperty("requestId").GetString(),
            ["supported"] = true,
            ["sdk"] = 34,
            ["installed"] = installed,
            ["isHome"] = isHome,
            ["disabledPackages"] = new JsonArray([.. (disabled ?? []).Select(p => (JsonNode)JsonValue.Create(p)!)]),
            ["apps"] = new JsonArray([.. (apps ?? []).Select(a => (JsonNode)new JsonObject
            {
                ["package"] = a.Package,
                ["factory"] = a.Factory,
                ["disabled"] = a.Disabled,
            })]),
            ["at"] = "2026-10-31T12:00:00Z",
        };
        if (version is not null)
        {
            body["version"] = version;
        }

        if (factory is not null)
        {
            body["factoryLauncher"] = factory;
        }

        return body;
    }

    /// <summary>O que o agente de verdade faz: o estado primeiro, o resultado do comando depois.</summary>
    private static async Task StateThenReplyAsync(FakeAgent agent, JsonElement command, JsonObject? state = null, JsonObject? result = null)
    {
        await agent.SendTextAsync(agent.Envelope("tv.livre.state.v1", state ?? StateBody(command), command.GetProperty("id").GetGuid()));
        await TvApp.ReplyAsync(agent, command, result);
    }

    private static async Task<JsonElement> NextAsync(FakeAgent agent, string type)
    {
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be(type);
        return command;
    }

    private static string ActionOf(JsonElement command) => command.GetProperty("body").GetProperty("action").GetString()!;

    /// <summary>Um JPEG mínimo mas estruturalmente válido (marcadores, quadro de 640x360, varredura e EOI) com o tamanho total pedido.</summary>
    private static byte[] Jpeg(int length) => TvJpeg.Build(640, 360, length);

    private static async Task<HttpResponseMessage> PutPhotoAsync(
        TvApp app, byte[] data, string contentType = "image/jpeg", string? bearer = "", HttpContent? content = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, $"{Base}/photo")
        {
            Content = content ?? new ByteArrayContent(data),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        var token = bearer == string.Empty ? app.Login.AccessToken : bearer;
        if (token is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        request.Headers.Add("X-Forwarded-For", TvApp.ClientIp);
        return await app.Client.SendAsync(request, Ct);
    }

    /// <summary>Corpo sem tamanho anunciado (transferência em pedaços): o teto precisa valer mesmo assim.</summary>
    private sealed class UnknownLengthContent(byte[] data) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context) =>
            stream.WriteAsync(data, Ct).AsTask();

        protected override bool TryComputeLength(out long length)
        {
            length = -1;
            return false;
        }
    }

    private static object Config(string wallpaperType = "gradient", int angle = 315, string size = "large") => new
    {
        clock = new { enabled = true, size, format = "24h", seconds = false, date = true },
        wallpaper = new { type = wallpaperType, colors = new[] { "#1B2440", "#3A2D5C" }, angle, dim = 0.25 },
        apps = new { mode = "all", items = Array.Empty<string>(), hidden = new[] { "com.exemplo.oculto" }, showFactory = false },
        icons = new { size = "medium", labels = "always" },
        builtin = new { settings = true, sleep = false },
        sleep = new { maxMinutes = 30 },
    };

    private static async Task SaveConfigAsync(TvApp app, object config)
    {
        using var response = await app.SendAsync(HttpMethod.Put, $"{Base}/config", config);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ---- a tela ----

    [Fact]
    public async Task TheView_WithoutAnAgent_IsUnavailable_WithTheDefaultConfig_AndNothingApplied()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var response = await app.GetAsync(Base);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var view = await TvApp.JsonAsync(response);
        view.GetProperty("available").GetBoolean().Should().BeFalse();
        view.GetProperty("supported").ValueKind.Should().Be(JsonValueKind.Null);
        view.GetProperty("stateAt").ValueKind.Should().Be(JsonValueKind.Null);
        view.GetProperty("installed").GetBoolean().Should().BeFalse();
        view.GetProperty("isHome").GetBoolean().Should().BeFalse();
        view.GetProperty("hasPhoto").GetBoolean().Should().BeFalse();
        view.GetProperty("revision").GetInt32().Should().Be(0);
        view.GetProperty("apps").GetArrayLength().Should().Be(0);
        var config = view.GetProperty("config");
        config.GetProperty("clock").GetProperty("size").GetString().Should().Be("large");
        config.GetProperty("wallpaper").GetProperty("colors").EnumerateArray().Select(c => c.GetString())
            .Should().Equal("#1B2440", "#3A2D5C");
        config.GetProperty("apps").GetProperty("mode").GetString().Should().Be("all");
        config.GetProperty("apps").GetProperty("showFactory").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task TheView_IsAvailable_OnlyWithAnOnlineAgentThatAnnouncesTheCapability()
    {
        await using var app = await TvApp.StartAsync(postgres);

        await using (var plain = await ConnectAsync(app, withCapability: false))
        {
            using var response = await app.GetAsync(Base);
            (await TvApp.JsonAsync(response)).GetProperty("available").GetBoolean().Should().BeFalse("o agente não anuncia o TV Livre");
        }

        await TvApp.WaitUntilAsync(() => app.Presence.Get(TvApp.AgentSlug)?.Connected == false, "agente fora");
        await using var capable = await ConnectAsync(app);
        using var available = await app.GetAsync(Base);
        (await TvApp.JsonAsync(available)).GetProperty("available").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Refresh_AsksForTheStatus_AndAnswersWithTheStateTheAgentSent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/refresh");
        var command = await NextAsync(agent, "tv.livre.v1");

        ActionOf(command).Should().Be("status");
        command.GetProperty("source").GetString().Should().Be("api");
        command.GetProperty("target").GetString().Should().Be($"agent:{TvApp.AgentSlug}");
        Guid.TryParse(command.GetProperty("body").GetProperty("requestId").GetString(), out _).Should().BeTrue();
        await StateThenReplyAsync(agent, command, StateBody(
            command, installed: true, isHome: true, version: "1.2.0", factory: "com.fabrica.home/.Main",
            disabled: ["com.fabrica.loja"], apps: [("com.exemplo.video", false, false), ("com.fabrica.loja", true, true)]));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var view = await TvApp.JsonAsync(response);
        view.GetProperty("available").GetBoolean().Should().BeTrue();
        view.GetProperty("supported").GetBoolean().Should().BeTrue();
        view.GetProperty("installed").GetBoolean().Should().BeTrue();
        view.GetProperty("isHome").GetBoolean().Should().BeTrue();
        view.GetProperty("version").GetString().Should().Be("1.2.0");
        view.GetProperty("factoryLauncher").GetString().Should().Be("com.fabrica.home/.Main");
        view.GetProperty("disabledPackages").EnumerateArray().Select(p => p.GetString()).Should().Equal("com.fabrica.loja");
        view.GetProperty("stateAt").GetDateTimeOffset().Should().Be(new DateTimeOffset(2026, 10, 31, 12, 0, 0, TimeSpan.Zero));
        var apps = view.GetProperty("apps").EnumerateArray().ToList();
        apps.Should().HaveCount(2);
        apps[1].GetProperty("package").GetString().Should().Be("com.fabrica.loja");
        apps[1].GetProperty("factory").GetBoolean().Should().BeTrue();
        apps[1].GetProperty("disabled").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task TheState_IsKept_AndComesBackOnTheNextGet()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        var request = app.PostAsync($"{Base}/refresh");
        var command = await NextAsync(agent, "tv.livre.v1");
        await StateThenReplyAsync(agent, command, StateBody(command, installed: true, version: "2.0.1"));
        (await Within(request)).Dispose();

        using var again = await app.GetAsync(Base);

        var view = await TvApp.JsonAsync(again);
        view.GetProperty("installed").GetBoolean().Should().BeTrue();
        view.GetProperty("version").GetString().Should().Be("2.0.1");
        await using var db = app.Db();
        var row = await db.TvLivre.SingleAsync(Ct);
        row.StateRequestId.Should().Be(command.GetProperty("body").GetProperty("requestId").GetGuid());
        row.StateAt.Should().NotBeNull();
    }

    [Fact]
    public async Task AStateTheAgentSendsOnItsOwn_IsKeptToo()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        var spontaneous = new JsonObject
        {
            ["requestId"] = Guid.NewGuid().ToString(),
            ["supported"] = true,
            ["installed"] = true,
            ["isHome"] = false,
            ["version"] = "3.0.0",
            ["apps"] = new JsonArray(),
            ["at"] = "2026-10-31T12:30:00Z",
        };

        await agent.SendTextAsync(agent.Envelope("tv.livre.state.v1", spontaneous));

        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.TvLivre.AnyAsync(e => e.StateJson != null, Ct);
        }, "estado guardado");
        using var response = await app.GetAsync(Base);
        (await TvApp.JsonAsync(response)).GetProperty("version").GetString().Should().Be("3.0.0");
    }

    [Fact]
    public async Task TheState_OfAnotherPairedAgent_IsIgnored()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        var other = await app.PairAsync("PC Trabalho");
        await using var intruder = await app.ConnectAsync(other);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(other.Slug)?.Connected == true, "outro conectado");

        await intruder.SendTextAsync(intruder.Envelope("tv.livre.state.v1", new JsonObject
        {
            ["requestId"] = Guid.NewGuid().ToString(),
            ["supported"] = true,
            ["installed"] = true,
            ["isHome"] = true,
            ["version"] = "9.9.9",
            ["apps"] = new JsonArray(),
            ["at"] = "2026-10-31T12:00:00Z",
        }));
        await TvApp.WaitUntilAsync(() => app.Presence.Get(other.Slug)?.LastMessageAt is not null, "mensagem do outro lida");

        await using var db = app.Db();
        (await db.TvLivre.CountAsync(Ct)).Should().Be(0, "só vale o estado do agente que controla a TV");
        using var response = await app.GetAsync(Base);
        (await TvApp.JsonAsync(response)).GetProperty("installed").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task AStepWhoseCommandSucceeds_ButWhoseStateNeverArrives_StillAnswersWithTheStoredView()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        // O install tem 90 s de espera: o primeiro salto do relógio (10 s) não vence o prazo antes de a resposta ser lida.
        var request = app.PostAsync($"{Base}/install");
        await TvApp.ReplyAsync(agent, await NextAsync(agent, "tv.livre.v1"));
        using var response = await app.AdvanceWhilePendingAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("stateAt").ValueKind.Should().Be(JsonValueKind.Null, "nada chegou, e a tela não inventa");
    }

    // ---- sem a capacidade ----

    [Theory]
    [InlineData("POST", "refresh")]
    [InlineData("POST", "apply")]
    [InlineData("POST", "install")]
    [InlineData("POST", "set-home")]
    [InlineData("POST", "restore")]
    [InlineData("POST", "sleep")]
    [InlineData("POST", "apps/visibility")]
    public async Task AStep_OnAnAgentWithoutTheCapability_Returns409_AndNothingReachesTheTv(string method, string route)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, withCapability: false);
        object? body = route == "apps/visibility" ? new { disable = new[] { "com.exemplo.app" } } : null;

        using var response = await Within(app.SendAsync(new HttpMethod(method), $"{Base}/{route}", body));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var problem = await TvApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/tv-livre-unsupported");
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0, "o comando nem saiu");
        (await db.TvLivre.CountAsync(Ct)).Should().Be(0, "a revisão não foi gasta");
    }

    [Fact]
    public async Task TheAgentSayingItIsUnsupported_AlsoReturns409WithTheSameType()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/refresh");
        await TvApp.ReplyAsync(agent, await NextAsync(agent, "tv.livre.v1"), TvApp.Failed("unsupported"));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var problem = await TvApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/tv-livre-unsupported");
        problem.GetProperty("agentError").GetString().Should().Be("unsupported");
    }

    [Fact]
    public async Task AStep_WithTheAgentOffline_Returns503_AndIsAudited()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.PassReconnectGrace();

        using var response = await app.PostAsync($"{Base}/install");

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-offline");
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.livre.install");
        row.ErrorCode.Should().Be("agent_offline");
    }

    // ---- os passos ----

    [Fact]
    public async Task Install_SendsTheInstallAction_IsAuditedWithItsOwnName_AndWaitsLongerThanTheOthers()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/install");
        var command = await NextAsync(agent, "tv.livre.v1");
        ActionOf(command).Should().Be("install");
        command.GetProperty("body").EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo("requestId", "action");

        // Os outros comandos desistem aos 8 s e a limpeza aos 30 s; o TV Livre tem 90 s.
        app.Time.Advance(TimeSpan.FromSeconds(45));
        await Task.Delay(300, Ct);
        request.IsCompleted.Should().BeFalse("o passo tem tempo próprio, maior que o dos outros comandos");

        await StateThenReplyAsync(agent, command, StateBody(command, installed: true, version: "1.0.0"));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("installed").GetBoolean().Should().BeTrue();
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.livre.install");
        row.AgentId.Should().Be(TvApp.AgentSlug);
        row.Ok.Should().BeTrue();
        row.Ip.Should().Be(TvApp.ClientIp);
    }

    [Fact]
    public async Task Install_WithoutAReplyWithinItsTimeout_Returns504_AndIsAudited()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/install");
        _ = await NextAsync(agent, "tv.livre.v1");
        using var response = await app.AdvanceWhilePendingAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.GatewayTimeout);
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.livre.install");
        row.ErrorCode.Should().Be("agent_timeout");
    }

    [Theory]
    [InlineData("apk_unavailable")]
    [InlineData("signature_mismatch")]
    [InlineData("adb_unreachable")]
    public async Task AFailureTheAgentReports_Returns502_WithTheStableCode_AndIsAudited(string code)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/install");
        await StateThenReplyAsync(agent, await NextAsync(agent, "tv.livre.v1"), result: TvApp.Failed(code));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var problem = await TvApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/command-failed");
        problem.GetProperty("agentError").GetString().Should().Be(code);
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).ErrorCode.Should().Be(code);
    }

    [Fact]
    public async Task AStep_WhileAnotherRunsOnTheSameTv_Returns409Busy_AndTheAgentReceivesOnlyTheFirst()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var first = app.PostAsync($"{Base}/install");
        var command = await NextAsync(agent, "tv.livre.v1");

        using var second = await Within(app.PostAsync($"{Base}/set-home", new { disableFactory = false }));
        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await TvApp.JsonAsync(second)).GetProperty("type").GetString().Should().EndWith("/tv-livre-busy");

        await StateThenReplyAsync(agent, command);
        (await Within(first)).StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(1, "o pedido recusado não chegou ao agente");

        // Terminado o primeiro, a vez volta.
        var third = app.PostAsync($"{Base}/refresh");
        await StateThenReplyAsync(agent, await NextAsync(agent, "tv.livre.v1"));
        (await Within(third)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public async Task SetHome_SendsTheDisableFactoryChoice_AndDefaultsToNo(bool? asked, bool sent)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/set-home", asked is null ? null : new { disableFactory = asked });
        var command = await NextAsync(agent, "tv.livre.v1");
        await StateThenReplyAsync(agent, command, StateBody(command, installed: true, isHome: true));
        using var response = await Within(request);

        ActionOf(command).Should().Be("set-home");
        command.GetProperty("body").GetProperty("disableFactory").GetBoolean().Should().Be(sent);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("isHome").GetBoolean().Should().BeTrue();
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).Command.Should().Be("tv.livre.set-home");
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(true, true)]
    [InlineData(false, false)]
    public async Task Restore_SendsTheUninstallChoice_AndDefaultsToYes(bool? asked, bool sent)
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/restore", asked is null ? null : new { uninstall = asked });
        var command = await NextAsync(agent, "tv.livre.v1");
        await StateThenReplyAsync(agent, command, StateBody(command));
        using var response = await Within(request);

        ActionOf(command).Should().Be("restore");
        command.GetProperty("body").GetProperty("uninstall").GetBoolean().Should().Be(sent);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).Command.Should().Be("tv.livre.restore");
    }

    [Fact]
    public async Task Sleep_SendsTheSleepAction_Answers204_AndIsAudited()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/sleep");
        var command = await NextAsync(agent, "tv.livre.v1");
        await TvApp.ReplyAsync(agent, command);
        using var response = await Within(request);

        ActionOf(command).Should().Be("sleep");
        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).Command.Should().Be("tv.livre.sleep");
    }

    [Fact]
    public async Task AppsVisibility_SendsBothLists_AndRefusesAnEmptyOrInvalidRequest()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        using (var empty = await app.PostAsync($"{Base}/apps/visibility", new { disable = Array.Empty<string>() }))
        {
            empty.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        using (var invalid = await app.PostAsync($"{Base}/apps/visibility", new { disable = BadPackage }))
        {
            invalid.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            (await TvApp.JsonAsync(invalid)).GetProperty("errors").TryGetProperty("disable", out _).Should().BeTrue();
        }

        using (var both = await app.PostAsync($"{Base}/apps/visibility", new { disable = SamePackage, enable = SamePackage }))
        {
            both.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        var request = app.PostAsync($"{Base}/apps/visibility", new { disable = ToDisable, enable = ToEnable });
        var command = await NextAsync(agent, "tv.livre.v1");
        await StateThenReplyAsync(agent, command, StateBody(command, disabled: ["com.fabrica.loja"], apps: [("com.fabrica.loja", true, true)]));
        using var response = await Within(request);

        ActionOf(command).Should().Be("set-apps");
        command.GetProperty("body").GetProperty("disable").EnumerateArray().Select(p => p.GetString()).Should().Equal("com.fabrica.loja");
        command.GetProperty("body").GetProperty("enable").EnumerateArray().Select(p => p.GetString()).Should().Equal("com.fabrica.tv");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("disabledPackages").GetArrayLength().Should().Be(1);
        await using var db = app.Db();
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.livre.set-apps");
        row.Detail.Should().Be("disable=1,enable=1", "a trilha guarda a contagem, não os pacotes");
    }

    // ---- a configuração ----

    [Fact]
    public async Task PutConfig_SavesWithoutApplying_AndTheViewReturnsIt()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        using var response = await app.SendAsync(HttpMethod.Put, $"{Base}/config", Config(size: "small", angle: 90));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var config = (await TvApp.JsonAsync(response)).GetProperty("config");
        config.GetProperty("clock").GetProperty("size").GetString().Should().Be("small");
        config.GetProperty("wallpaper").GetProperty("angle").GetInt32().Should().Be(90);
        config.GetProperty("apps").GetProperty("hidden").EnumerateArray().Select(p => p.GetString()).Should().Equal("com.exemplo.oculto");
        config.GetProperty("sleep").GetProperty("maxMinutes").GetInt32().Should().Be(30);

        using var again = await app.GetAsync(Base);
        var view = await TvApp.JsonAsync(again);
        view.GetProperty("config").GetProperty("clock").GetProperty("size").GetString().Should().Be("small");
        view.GetProperty("revision").GetInt32().Should().Be(0, "guardar não aplica");
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0, "nada foi à TV");
    }

    [Fact]
    public async Task PutConfig_WithTheAppListsOmitted_StoresThemAsEmptyLists()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var sparse = new
        {
            clock = new { },
            wallpaper = new { colors = new[] { "#000000" } },
            apps = new { mode = "all", showFactory = true },
            icons = new { },
            builtin = new { },
            sleep = new { },
        };

        using var response = await app.SendAsync(HttpMethod.Put, $"{Base}/config", sparse);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var config = (await TvApp.JsonAsync(response)).GetProperty("config");
        config.GetProperty("apps").GetProperty("items").ValueKind.Should().Be(JsonValueKind.Array);
        config.GetProperty("apps").GetProperty("hidden").GetArrayLength().Should().Be(0);
        config.GetProperty("apps").GetProperty("showFactory").GetBoolean().Should().BeTrue();
        config.GetProperty("clock").GetProperty("size").GetString().Should().Be("large", "o que se omite vale o padrão");
        config.GetProperty("wallpaper").GetProperty("angle").GetInt32().Should().Be(315);
    }

    [Fact]
    public async Task PutConfig_WithInvalidValues_Returns400WithOneMessagePerField_AndSavesNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var invalid = new
        {
            clock = new { enabled = true, size = "enorme", format = "24h", seconds = false, date = true },
            wallpaper = new { type = "gradient", colors = new[] { "azul" }, angle = 44, dim = 0.9 },
            apps = new { mode = "all", items = new[] { "nome ruim" }, hidden = Array.Empty<string>(), showFactory = false },
            icons = new { size = "medium", labels = "always" },
            builtin = new { settings = true, sleep = false },
            sleep = new { maxMinutes = 721 },
        };

        using var response = await app.SendAsync(HttpMethod.Put, $"{Base}/config", invalid);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var errors = (await TvApp.JsonAsync(response)).GetProperty("errors");
        errors.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(
            "clock.size", "wallpaper.colors", "wallpaper.angle", "wallpaper.dim", "apps.items", "sleep.maxMinutes");
        await using var db = app.Db();
        (await db.TvLivre.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task PutConfig_WithAnUnknownField_OrAMissingSection_Returns400()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var extra = await app.SendAsync(HttpMethod.Put, $"{Base}/config", new
        {
            clock = new { enabled = true, size = "large", format = "24h", seconds = false, date = true, cor = "azul" },
        });
        using var missing = await app.SendAsync(HttpMethod.Put, $"{Base}/config", new { clock = new { size = "large" } });
        using var empty = await app.SendAsync(HttpMethod.Put, $"{Base}/config", new { });

        extra.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        missing.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        empty.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await TvApp.JsonAsync(empty)).GetProperty("errors").EnumerateObject().Select(p => p.Name)
            .Should().Contain(["wallpaper", "apps", "icons", "builtin", "sleep"]);
    }

    // ---- a foto ----

    [Fact]
    public async Task Photo_IsSaved_ReturnedWithItsEtag_AndRemoved()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var photo = Jpeg(70_000);

        using (var put = await PutPhotoAsync(app, photo))
        {
            put.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        using (var get = await app.GetAsync($"{Base}/photo"))
        {
            get.StatusCode.Should().Be(HttpStatusCode.OK);
            get.Content.Headers.ContentType!.MediaType.Should().Be("image/jpeg");
            (await get.Content.ReadAsByteArrayAsync(Ct)).Should().Equal(photo);
            get.Headers.ETag!.Tag.Should().Be($"\"{Convert.ToHexStringLower(SHA256.HashData(photo))}\"");
            get.Headers.CacheControl!.NoStore.Should().BeTrue("a API inteira responde com no-store");
        }

        using (var view = await app.GetAsync(Base))
        {
            (await TvApp.JsonAsync(view)).GetProperty("hasPhoto").GetBoolean().Should().BeTrue();
        }

        using (var delete = await app.SendAsync(HttpMethod.Delete, $"{Base}/photo"))
        {
            delete.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        using (var gone = await app.GetAsync($"{Base}/photo"))
        {
            gone.StatusCode.Should().Be(HttpStatusCode.NotFound);
        }

        using var after = await app.GetAsync(Base);
        (await TvApp.JsonAsync(after)).GetProperty("hasPhoto").GetBoolean().Should().BeFalse();
        using var again = await app.SendAsync(HttpMethod.Delete, $"{Base}/photo");
        again.StatusCode.Should().Be(HttpStatusCode.NoContent, "apagar o que não existe também é 204");
    }

    [Fact]
    public async Task Photo_WithoutOne_Returns404()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var response = await app.GetAsync($"{Base}/photo");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Photo_AtTheLimitOf400KiB_IsAccepted_AndOneByteMoreIs413()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using (var atLimit = await PutPhotoAsync(app, Jpeg(400 * 1024)))
        {
            atLimit.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        using var over = await PutPhotoAsync(app, Jpeg((400 * 1024) + 1));

        over.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
        (await TvApp.JsonAsync(over)).GetProperty("type").GetString().Should().EndWith("/tv-livre-photo-too-large");
        await using var db = app.Db();
        (await db.TvLivre.SingleAsync(Ct)).PhotoData!.Length.Should().Be(400 * 1024, "a foto maior não trocou a guardada");
    }

    [Fact]
    public async Task Photo_WithoutAnAnnouncedLength_IsStillCappedWhileReading()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var over = await PutPhotoAsync(app, [], content: new UnknownLengthContent(Jpeg((400 * 1024) + 5000)));
        using var fine = await PutPhotoAsync(app, [], content: new UnknownLengthContent(Jpeg(1000)));

        over.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
        fine.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Photo_ThatIsNotAJpeg_Returns415_AndSavesNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        byte[] png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];

        using var pngBody = await PutPhotoAsync(app, png);
        using var wrongType = await PutPhotoAsync(app, Jpeg(1000), contentType: "image/png");
        using var empty = await PutPhotoAsync(app, []);

        pngBody.StatusCode.Should().Be(HttpStatusCode.UnsupportedMediaType, "o corpo não começa com FF D8 FF");
        wrongType.StatusCode.Should().Be(HttpStatusCode.UnsupportedMediaType, "o tipo declarado não é image/jpeg");
        empty.StatusCode.Should().Be(HttpStatusCode.UnsupportedMediaType);
        await using var db = app.Db();
        (await db.TvLivre.CountAsync(e => e.PhotoData != null, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Photo_ThatIsTruncated_HasNoFrame_OrIsNoiseBehindTheMagicBytes_Returns415_AndSavesNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var whole = TvJpeg.Build(640, 360, 3000);
        var head = TvJpeg.Head(640, 360);
        var noise = new byte[3000];
        new Random(3).NextBytes(noise);
        noise[0] = 0xFF;
        noise[1] = 0xD8;
        noise[2] = 0xFF;
        (string Name, byte[] Data)[] cases =
        [
            ("sem o fim (EOI)", whole[..^2]),
            ("cortado no meio", whole[..1500]),
            ("sem quadro (SOF)", [.. head[..2], .. head[15..], 0x11, 0xFF, 0xD9]),
            ("ruído atrás dos bytes mágicos", noise),
            ("sobra depois do EOI", [.. whole, 0x00]),
        ];

        foreach (var (name, data) in cases)
        {
            using var response = await PutPhotoAsync(app, data);

            response.StatusCode.Should().Be(HttpStatusCode.UnsupportedMediaType, name);
        }

        await using var db = app.Db();
        (await db.TvLivre.CountAsync(e => e.PhotoData != null, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Photo_WithDimensionsOutsideOneTo4096_Returns400_AndTheLimitsThemselvesPass()
    {
        await using var app = await TvApp.StartAsync(postgres);

        foreach (var (width, height) in new[] { (5000, 100), (100, 4097), (0, 10), (10, 0) })
        {
            using var response = await PutPhotoAsync(app, TvJpeg.Build(width, height, 2000));

            response.StatusCode.Should().Be(HttpStatusCode.BadRequest, $"{width}x{height}");
            (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/tv-livre-photo-dimensions");
        }

        await using (var db = app.Db())
        {
            (await db.TvLivre.CountAsync(e => e.PhotoData != null, Ct)).Should().Be(0);
        }

        using var biggest = await PutPhotoAsync(app, TvJpeg.Build(4096, 4096, 2000));
        using var smallest = await PutPhotoAsync(app, TvJpeg.Build(1, 1));

        biggest.StatusCode.Should().Be(HttpStatusCode.NoContent);
        smallest.StatusCode.Should().Be(HttpStatusCode.NoContent, "o menor JPEG válido possível");
    }

    // ---- a vez por TV vale entre instâncias ----

    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities", Justification = "O nome da função vem de constantes do próprio teste.")]
    private static async Task<bool> AdvisoryAsync(NpgsqlConnection connection, string function, long key)
    {
        await using var command = new NpgsqlCommand($"SELECT {function}(@key)", connection);
        command.Parameters.AddWithValue("key", key);
        return (bool)(await command.ExecuteScalarAsync(Ct))!;
    }

    [Fact]
    public async Task TheTurn_IsAPostgresAdvisoryLock_ThatAnotherSessionCannotTake_UntilItIsReleased()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var requests = app.Services.GetRequiredService<ITvLivreRequests>();
        var tv = Guid.NewGuid();
        await using var otherInstance = new NpgsqlConnection(app.Database.OwnerConnection);
        await otherInstance.OpenAsync(Ct);

        var first = await requests.TryBeginAsync(tv, Ct);

        first.Should().NotBeNull();
        (await requests.TryBeginAsync(tv, Ct)).Should().BeNull("a mesma TV só tem um passo por vez");
        (await AdvisoryAsync(otherInstance, "pg_try_advisory_lock", TvLivreRequests.KeyOf(tv))).Should().BeFalse("outra sessão do banco não toma a vez");
        await using (var otherTv = await requests.TryBeginAsync(Guid.NewGuid(), Ct))
        {
            otherTv.Should().NotBeNull("TVs diferentes não dividem a vez");
        }

        await first!.DisposeAsync();

        (await AdvisoryAsync(otherInstance, "pg_try_advisory_lock", TvLivreRequests.KeyOf(tv))).Should().BeTrue("o descarte soltou a trava");
        (await requests.TryBeginAsync(tv, Ct)).Should().BeNull("agora é a outra sessão que a tem");
        (await AdvisoryAsync(otherInstance, "pg_advisory_unlock", TvLivreRequests.KeyOf(tv))).Should().BeTrue();
        await using var again = await requests.TryBeginAsync(tv, Ct);
        again.Should().NotBeNull();
    }

    [Fact]
    public async Task AStep_WhileAnotherInstanceHoldsTheTurn_Returns409Busy_AndRunsOnceItIsReleased()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        await using var otherInstance = new NpgsqlConnection(app.Database.OwnerConnection);
        await otherInstance.OpenAsync(Ct);
        var key = TvLivreRequests.KeyOf(Guid.Empty);
        (await AdvisoryAsync(otherInstance, "pg_try_advisory_lock", key)).Should().BeTrue();

        using (var busy = await Within(app.PostAsync($"{Base}/install")))
        {
            busy.StatusCode.Should().Be(HttpStatusCode.Conflict);
            (await TvApp.JsonAsync(busy)).GetProperty("type").GetString().Should().EndWith("/tv-livre-busy");
        }

        await using (var db = app.Db())
        {
            (await db.CommandAudit.CountAsync(Ct)).Should().Be(0, "o comando nem saiu");
        }

        (await AdvisoryAsync(otherInstance, "pg_advisory_unlock", key)).Should().BeTrue();
        var request = app.PostAsync($"{Base}/install");
        await StateThenReplyAsync(agent, await NextAsync(agent, "tv.livre.v1"));
        (await Within(request)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task TheState_ThatAnotherInstanceStoredInTheDatabase_IsFoundByThePollingWait()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        // O agente está ligado a outra instância: aqui só chega o resultado do comando, e o estado entra no banco por lá.
        var request = app.PostAsync($"{Base}/install");
        var command = await NextAsync(agent, "tv.livre.v1");
        await TvApp.ReplyAsync(agent, command);
        var requestId = command.GetProperty("body").GetProperty("requestId").GetString();
        await app.ExecuteSqlAsync($$"""
            INSERT INTO tv.tv_livre (tv_id, revision, updated_at, state_json, state_request_id, state_at)
            VALUES ('{{Guid.Empty}}', 0, now(),
                '{"supported":true,"installed":true,"isHome":false,"version":"7.7.7","apps":[],"at":"2026-10-31T12:00:00Z"}'::jsonb,
                '{{requestId}}', now())
            ON CONFLICT (tv_id) DO UPDATE SET state_json = EXCLUDED.state_json,
                state_request_id = EXCLUDED.state_request_id, state_at = EXCLUDED.state_at
            """);
        using var response = await app.AdvanceWhilePendingAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var view = await TvApp.JsonAsync(response);
        view.GetProperty("version").GetString().Should().Be("7.7.7");
        view.GetProperty("installed").GetBoolean().Should().BeTrue();
    }

    // ---- a revisão é reservada no banco ----

    [Fact]
    public async Task NextRevision_IsReservedAtomically_EvenWithManyParallelWriters()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tv = Guid.NewGuid();

        var revisions = await Task.WhenAll(Enumerable.Range(0, 20).Select(async _ =>
        {
            await using var scope = app.Services.CreateAsyncScope();
            return await scope.ServiceProvider.GetRequiredService<TvLivreStore>().NextRevisionAsync(tv, Ct);
        }));

        revisions.Order().Should().Equal(Enumerable.Range(1, 20), "duas aplicações nunca usam o mesmo número, e a primeira cria a linha");
        await using var db = app.Db();
        (await db.TvLivre.AsNoTracking().SingleAsync(e => e.TvId == tv, Ct)).Revision.Should().Be(20);
    }

    [Fact]
    public async Task NextRevision_KeepsTheStoredConfigAndPhoto_OfTheRowItIncrements()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await SaveConfigAsync(app, Config());
        (await PutPhotoAsync(app, Jpeg(2000))).Dispose();

        await using (var scope = app.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<TvLivreStore>().NextRevisionAsync(Guid.Empty, Ct)).Should().Be(1);
        }

        await using var db = app.Db();
        var row = await db.TvLivre.AsNoTracking().SingleAsync(Ct);
        row.Revision.Should().Be(1);
        row.ConfigJson.Should().NotBeNull();
        row.PhotoData!.Length.Should().Be(2000);
    }

    // ---- aplicar ----

    [Fact]
    public async Task Apply_WithoutAPhoto_SendsTheLauncherConfigWithARevision_AndTheRevisionOnlyGrows()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        await SaveConfigAsync(app, Config());

        var first = app.PostAsync($"{Base}/apply");
        var one = await NextAsync(agent, "tv.livre.v1");
        await StateThenReplyAsync(agent, one);
        using var firstResponse = await Within(first);

        ActionOf(one).Should().Be("apply");
        one.GetProperty("body").GetProperty("revision").GetInt32().Should().Be(1);
        one.GetProperty("body").TryGetProperty("photoId", out _).Should().BeFalse("o fundo é degradê");
        var launcher = JsonNode.Parse(one.GetProperty("body").GetProperty("configJson").GetString()!)!.AsObject();
        launcher.Select(p => p.Key).Should().Equal("clock", "wallpaper", "apps", "icons", "builtin", "sleep");
        launcher["apps"]!["hidden"]!.AsArray().Select(n => n!.GetValue<string>()).Should().Equal("com.exemplo.oculto");
        launcher["sleep"]!["maxMinutes"]!.GetValue<int>().Should().Be(30);
        firstResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(firstResponse)).GetProperty("revision").GetInt32().Should().Be(1);

        var second = app.PostAsync($"{Base}/apply");
        var two = await NextAsync(agent, "tv.livre.v1");
        await StateThenReplyAsync(agent, two);
        using var secondResponse = await Within(second);

        two.GetProperty("body").GetProperty("revision").GetInt32().Should().Be(2);
        (await TvApp.JsonAsync(secondResponse)).GetProperty("revision").GetInt32().Should().Be(2);
        await using var db = app.Db();
        var rows = await db.CommandAudit.OrderBy(a => a.OccurredAt).ToListAsync(Ct);
        rows.Select(r => r.Command).Should().OnlyContain(c => c == "tv.livre.apply").And.HaveCount(2);
        rows.Select(r => r.Detail).Should().BeEquivalentTo(["revision=1", "revision=2"]);
    }

    [Fact]
    public async Task Apply_WithoutAStoredConfig_AppliesTheDefault()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/apply");
        var command = await NextAsync(agent, "tv.livre.v1");
        await StateThenReplyAsync(agent, command);
        (await Within(request)).Dispose();

        var launcher = JsonNode.Parse(command.GetProperty("body").GetProperty("configJson").GetString()!)!.AsObject();
        launcher["apps"]!["mode"]!.GetValue<string>().Should().Be("all");
        launcher["apps"]!["showFactory"]!.GetValue<bool>().Should().BeFalse();
        launcher["wallpaper"]!["colors"]!.AsArray().Select(n => n!.GetValue<string>()).Should().Equal("#1B2440", "#3A2D5C");
    }

    [Fact]
    public async Task Apply_WithAPhotoBackground_SendsTheChunksFirst_ThenTheApplyWithTheSamePhotoId()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        await SaveConfigAsync(app, Config(wallpaperType: "photo"));
        var photo = Jpeg(70_000);
        using (var put = await PutPhotoAsync(app, photo))
        {
            put.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        var request = app.PostAsync($"{Base}/apply");
        var chunks = new List<JsonElement>();
        JsonElement apply;
        while (true)
        {
            var command = await TvApp.NextCommandAsync(agent);
            if (command.GetProperty("type").GetString() == "tv.livre.v1")
            {
                apply = command;
                break;
            }

            command.GetProperty("type").GetString().Should().Be("tv.livre.photo.v1");
            chunks.Add(command);
            await TvApp.ReplyAsync(agent, command);
        }

        await StateThenReplyAsync(agent, apply);
        using var response = await Within(request);

        chunks.Should().HaveCount(3, "70000 bytes em pedaços de 30000");
        var bodies = chunks.Select(c => c.GetProperty("body")).ToList();
        bodies.Select(b => b.GetProperty("index").GetInt32()).Should().Equal(0, 1, 2);
        bodies.Select(b => b.GetProperty("total").GetInt32()).Should().OnlyContain(t => t == 3);
        var photoId = bodies[0].GetProperty("photoId").GetGuid();
        bodies.Select(b => b.GetProperty("photoId").GetGuid()).Should().OnlyContain(id => id == photoId);
        var sha = Convert.ToHexStringLower(SHA256.HashData(photo));
        bodies.Select(b => b.GetProperty("sha256").GetString()).Should().OnlyContain(s => s == sha);
        var joined = bodies.SelectMany(b => Convert.FromBase64String(b.GetProperty("data").GetString()!)).ToArray();
        joined.Should().Equal(photo);
        bodies.Take(2).Select(b => Convert.FromBase64String(b.GetProperty("data").GetString()!).Length).Should().OnlyContain(n => n == 30000);

        apply.GetProperty("body").GetProperty("photoId").GetGuid().Should().Be(photoId);
        apply.GetProperty("body").GetProperty("revision").GetInt32().Should().Be(1);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.CommandAudit.SingleAsync(Ct)).Command.Should().Be("tv.livre.apply", "os pedaços não deixam linha própria");
    }

    [Fact]
    public async Task Apply_AgainWithThePhoto_UsesANewPhotoId()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        await SaveConfigAsync(app, Config(wallpaperType: "photo"));
        (await PutPhotoAsync(app, Jpeg(5000))).Dispose();

        var ids = new List<Guid>();
        for (var round = 0; round < 2; round++)
        {
            var request = app.PostAsync($"{Base}/apply");
            var chunk = await NextAsync(agent, "tv.livre.photo.v1");
            ids.Add(chunk.GetProperty("body").GetProperty("photoId").GetGuid());
            await TvApp.ReplyAsync(agent, chunk);
            var apply = await NextAsync(agent, "tv.livre.v1");
            await StateThenReplyAsync(agent, apply);
            (await Within(request)).Dispose();
        }

        ids[0].Should().NotBe(ids[1], "cada aplicação leva a foto com um identificador novo");
    }

    [Fact]
    public async Task Apply_WithAGradientBackground_NeverSendsTheStoredPhoto()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        await SaveConfigAsync(app, Config(wallpaperType: "gradient"));
        (await PutPhotoAsync(app, Jpeg(5000))).Dispose();

        var request = app.PostAsync($"{Base}/apply");
        var command = await NextAsync(agent, "tv.livre.v1");
        await StateThenReplyAsync(agent, command);
        (await Within(request)).Dispose();

        command.GetProperty("body").TryGetProperty("photoId", out _).Should().BeFalse();
    }

    [Fact]
    public async Task Apply_WhenAChunkIsRefused_Returns502_SendsNoApply_KeepsTheRevision_AndAuditsTheFailure()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        await SaveConfigAsync(app, Config(wallpaperType: "photo"));
        (await PutPhotoAsync(app, Jpeg(40_000))).Dispose();

        var request = app.PostAsync($"{Base}/apply");
        var chunk = await NextAsync(agent, "tv.livre.photo.v1");
        await TvApp.ReplyAsync(agent, chunk, TvApp.Failed("invalid_photo"));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await TvApp.JsonAsync(response)).GetProperty("agentError").GetString().Should().Be("invalid_photo");
        await using var db = app.Db();
        (await db.TvLivre.SingleAsync(Ct)).Revision.Should().Be(0, "o apply nem saiu");
        var row = await db.CommandAudit.SingleAsync(Ct);
        row.Command.Should().Be("tv.livre.apply");
        row.Detail.Should().Be("photo");
        row.ErrorCode.Should().Be("invalid_photo");
        row.Ok.Should().BeFalse();

        // A vez foi devolvida e o pedido seguinte recomeça pela primeira peça, e termina.
        var retry = app.PostAsync($"{Base}/apply");
        var first = await NextAsync(agent, "tv.livre.photo.v1");
        first.GetProperty("body").GetProperty("index").GetInt32().Should().Be(0);
        await TvApp.ReplyAsync(agent, first);
        await TvApp.ReplyAsync(agent, await NextAsync(agent, "tv.livre.photo.v1"));
        var apply = await NextAsync(agent, "tv.livre.v1");
        apply.GetProperty("body").GetProperty("revision").GetInt32().Should().Be(1);
        await StateThenReplyAsync(agent, apply);
        (await Within(retry)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Apply_ThatTheAgentFails_Returns502_AndStillSpendsTheRevision()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);

        var request = app.PostAsync($"{Base}/apply");
        var command = await NextAsync(agent, "tv.livre.v1");
        await StateThenReplyAsync(agent, command, result: TvApp.Failed("not_installed"));
        using var response = await Within(request);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await TvApp.JsonAsync(response)).GetProperty("agentError").GetString().Should().Be("not_installed");
        using var view = await app.GetAsync(Base);
        (await TvApp.JsonAsync(view)).GetProperty("revision").GetInt32().Should().Be(1,
            "o launcher só aceita revisão maior; um comando que pode ter chegado nunca devolve o número");
    }

    // ---- porta fechada ----

    private static readonly (string Method, string Path, object? Body)[] AllRoutes =
    [
        ("GET", Base, null),
        ("POST", $"{Base}/refresh", null),
        ("PUT", $"{Base}/config", new { }),
        ("PUT", $"{Base}/photo", null),
        ("GET", $"{Base}/photo", null),
        ("DELETE", $"{Base}/photo", null),
        ("POST", $"{Base}/apply", null),
        ("POST", $"{Base}/install", null),
        ("POST", $"{Base}/set-home", new { disableFactory = false }),
        ("POST", $"{Base}/restore", new { uninstall = true }),
        ("POST", $"{Base}/sleep", null),
        ("POST", $"{Base}/apps/visibility", new { disable = new[] { "com.exemplo.app" } }),
    ];

    [Fact]
    public async Task EveryRoute_IsDeniedToAGuestWithEveryTvPermission_AndNothingReachesTheTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app);
        string[] everything = ["module:tv", "tv:control", "tv:power", "tv:launch", "tv:edit-shortcuts", "tv:history"];
        var guest = await app.NewGuestAsync("Sala", everything, 61);

        var refusals = new List<string>();
        foreach (var (method, path, body) in AllRoutes)
        {
            using var response = await app.SendAsync(new HttpMethod(method), path, body, bearer: guest.Login.AccessToken);
            refusals.Add($"{method} {path} => {(int)response.StatusCode}");
        }

        refusals.Should().OnlyContain(line => line.EndsWith("=> 403", StringComparison.Ordinal));
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(Ct)).Should().Be(0);
        (await db.TvLivre.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task EveryRoute_IsDeniedToAnAnonymousCaller_With401()
    {
        await using var app = await TvApp.StartAsync(postgres);

        var results = new List<string>();
        foreach (var (method, path, body) in AllRoutes)
        {
            using var response = await app.SendAsync(new HttpMethod(method), path, body, bearer: null);
            results.Add($"{method} {path} => {(int)response.StatusCode}");
        }

        results.Should().OnlyContain(line => line.EndsWith("=> 401", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TheOwner_ReachesEveryRoute()
    {
        await using var app = await TvApp.StartAsync(postgres);
        // Sem agente conectado o comando falha na hora com 503 em vez de esperar a sessão voltar.
        app.PassReconnectGrace();

        foreach (var (method, path, body) in AllRoutes.Where(r => r.Path != $"{Base}/photo" || r.Method != "PUT"))
        {
            using var response = await app.SendAsync(new HttpMethod(method), path, body);
            TvPermissionMap.Reached(response.StatusCode).Should().BeTrue($"{method} {path} para o dono (respondeu {(int)response.StatusCode})");
        }
    }

    [Fact]
    public async Task APhotoUpload_ByAGuest_IsDeniedBeforeReadingTheBody()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("Sala", ["module:tv", "tv:control"], 62);

        using var response = await PutPhotoAsync(app, Jpeg(1000), bearer: guest.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.TvLivre.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task TheCommandsLimit_AlsoCoversTheLivreSteps_With429AndRetryAfter()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { CommandsPermitted = 2 });
        app.PassReconnectGrace();

        for (var i = 0; i < 2; i++)
        {
            using var allowed = await app.PostAsync($"{Base}/refresh");
            allowed.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, "o agente está fora, mas o limite ainda não estourou");
        }

        using var limited = await app.PostAsync($"{Base}/install");

        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        limited.Headers.RetryAfter.Should().NotBeNull();
    }

    // ---- banco ----

    [Fact]
    public async Task TheMigration_MatchesTheModelSnapshot_AndTheTableHasItsColumns()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var db = app.Db();

        db.Database.HasPendingModelChanges().Should().BeFalse("o modelo do código e o último snapshot de migration precisam coincidir");
        await app.ExecuteSqlAsync(
            "INSERT INTO tv.tv_livre (tv_id, revision, updated_at) VALUES ('0192f1e4-0000-7000-8000-0000000000a1', 0, now())");
        (await db.TvLivre.AsNoTracking().SingleAsync(Ct)).Revision.Should().Be(0);
    }

    [Fact]
    public async Task TheViewAfterConfigAndPhoto_ListsBothInOneRow()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await SaveConfigAsync(app, Config());
        (await PutPhotoAsync(app, Jpeg(2000))).Dispose();

        await using var db = app.Db();
        var row = await db.TvLivre.AsNoTracking().SingleAsync(Ct);
        row.ConfigJson.Should().NotBeNull();
        row.PhotoData!.Length.Should().Be(2000);
        row.PhotoSha256.Should().HaveLength(64);
        (await db.TvLivre.CountAsync(Ct)).Should().Be(1, "uma linha por TV");
    }
}
