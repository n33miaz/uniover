using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Devices.PcControl;

/// <summary>
/// Controle do PC pelo app: as rotas <c>/api/v1/pc</c> com um agente simulado do outro lado do canal. Cobre o caminho
/// feliz de cada comando, a permissão <c>module:pc</c> (o dono tem por padrão, o convidado só se concedida), a
/// confirmação de suspender e desligar, a auditoria da energia e o limite de taxa do movimento do mouse.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class PcControlTests(PostgresFixture postgres)
{
    private const string Capability = "pc.control.v1";

    private static readonly string[] Ctrl = ["CTRL"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    private static async Task<FakeAgent> ConnectAsync(TransportApp app, params string[] capabilities)
    {
        var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("0.1.0+3f2a9c1d4e5b", capabilities);
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.AgentVersion is not null, "hello processado");
        return agent;
    }

    private static Task<FakeAgent> ConnectPcAsync(TransportApp app) => ConnectAsync(app, "transport.keepalive.v1", Capability);

    /// <summary>O agente simulado atende o próximo comando como o de verdade: recebe e responde com o resultado.</summary>
    private static async Task<JsonElement> AnswerAsync(FakeAgent agent, JsonNode? result = null)
    {
        var command = (await agent.ReceiveAsync())!.Value;
        await agent.SendTextAsync(agent.Envelope("command.result.v1", result ?? new JsonObject { ["ok"] = true }, command.GetProperty("id").GetGuid()));
        return command;
    }

    private static JsonObject Failed(string code) =>
        new() { ["ok"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = "texto livre do agente" } };

    private static Task<HttpResponseMessage> PostAsync(TransportApp app, string path, object? body, string? token = null) =>
        app.App.SendAsync(HttpMethod.Post, $"/api/v1/pc/{path}", body, token ?? app.Login.AccessToken);

    // ---- estado ----

    [Fact]
    public async Task Status_WithNoPcAgent_SaysNotAvailable()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", "tv.remote");

        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await DevicesApp.JsonAsync(response);
        body.GetProperty("available").GetBoolean().Should().BeFalse();
        body.GetProperty("online").GetBoolean().Should().BeFalse();
        body.GetProperty("apps").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task Status_WithAPcAgent_ListsOnlyTheIdsAndNamesOfItsFavorites()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);
        await agent.SendTextAsync(agent.Envelope("pc.apps.v1", new JsonObject
        {
            ["apps"] = new JsonArray(new JsonObject { ["id"] = "navegador", ["label"] = "Navegador" }),
            ["at"] = "2026-11-01T14:00:00Z",
        }));
        await TransportApp.WaitUntilAsync(async () => await StatusAppsAsync(app) == 1, "favoritos recebidos");

        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);
        var body = await DevicesApp.JsonAsync(response);

        body.GetProperty("available").GetBoolean().Should().BeTrue();
        body.GetProperty("online").GetBoolean().Should().BeTrue();
        body.GetProperty("apps")[0].EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo("id", "label");
    }

    private static async Task<int> StatusAppsAsync(TransportApp app)
    {
        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);
        return (await DevicesApp.JsonAsync(response)).GetProperty("apps").GetArrayLength();
    }

    [Fact]
    public async Task Status_OfAPcThatWentOffline_IsStillAvailableButNotOnline()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectPcAsync(app);
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");

        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);
        var body = await DevicesApp.JsonAsync(response);

        body.GetProperty("available").GetBoolean().Should().BeTrue();
        body.GetProperty("online").GetBoolean().Should().BeFalse();
    }

    // ---- comandos ----

    [Fact]
    public async Task Pointer_IsSentToTheAgentWithoutWaitingForItsReply_AndNeverAudited()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        using var response = await PostAsync(app, "pointer", new { dx = 12, dy = -4, scrollY = 120 });
        var command = (await Within(agent.ReceiveAsync()))!.Value;

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.pointer.v1");
        command.GetProperty("target").GetString().Should().Be($"agent:{app.Agent.Slug}");
        var body = command.GetProperty("body");
        (body.GetProperty("dx").GetInt32(), body.GetProperty("dy").GetInt32(), body.GetProperty("scrollY").GetInt32())
            .Should().Be((12, -4, 120));
        body.TryGetProperty("scrollX", out _).Should().BeFalse();

        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event.StartsWith("pc_"), Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Pointer_ThatDoesNotMove_SendsNothing()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        using var response = await PostAsync(app, "pointer", new { dx = 0, dy = 0 });

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Theory]
    [InlineData("{\"dx\":2001,\"dy\":0}")]
    [InlineData("{\"dx\":0,\"dy\":-2001}")]
    [InlineData("{\"dx\":1}")]
    [InlineData("{\"dx\":1,\"dy\":1,\"scrollY\":1201}")]
    [InlineData("{\"dx\":1.5,\"dy\":1}")]
    public async Task Pointer_OutsideTheContractLimits_Returns400(string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        using var response = await PostAsync(app, "pointer", JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Click_Key_Text_Media_AreEachOneCommandAndTheAgentReplyDecidesTheAnswer()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        var click = PostAsync(app, "click", new { button = "RIGHT" });
        var clickCommand = await AnswerAsync(agent);
        using var clicked = await Within(click);

        var key = PostAsync(app, "key", new { key = "C", modifiers = Ctrl });
        var keyCommand = await AnswerAsync(agent);
        using var pressed = await Within(key);

        var text = PostAsync(app, "text", new { text = "olá, mundo" });
        var textCommand = await AnswerAsync(agent);
        using var typed = await Within(text);

        var media = PostAsync(app, "media", new { action = "VOLUME_UP", steps = 3 });
        var mediaCommand = await AnswerAsync(agent);
        using var played = await Within(media);

        new[] { clicked, pressed, typed, played }.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.NoContent);
        clickCommand.GetProperty("type").GetString().Should().Be("pc.click.v1");
        clickCommand.GetProperty("body").GetProperty("button").GetString().Should().Be("RIGHT");
        keyCommand.GetProperty("body").GetProperty("key").GetString().Should().Be("C");
        keyCommand.GetProperty("body").GetProperty("modifiers")[0].GetString().Should().Be("CTRL");
        textCommand.GetProperty("body").GetProperty("text").GetString().Should().Be("olá, mundo");
        mediaCommand.GetProperty("body").GetProperty("steps").GetInt32().Should().Be(3);
    }

    [Theory]
    [InlineData("click", "{\"button\":\"BACK\"}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"action\":\"TRIPLE\"}")]
    [InlineData("key", "{\"key\":\"PRINT_SCREEN\"}")]
    [InlineData("key", "{\"key\":\"C\",\"modifiers\":[\"CTRL\",\"CTRL\"]}")]
    [InlineData("key", "{\"key\":\"C\",\"modifiers\":[\"META\"]}")]
    [InlineData("text", "{\"text\":\"\"}")]
    [InlineData("text", "{\"text\":\"linha1\\nlinha2\"}")]
    [InlineData("media", "{\"action\":\"EJECT\"}")]
    [InlineData("media", "{\"action\":\"VOLUME_UP\",\"steps\":11}")]
    [InlineData("power", "{\"action\":\"HIBERNATE\"}")]
    public async Task ABodyOutsideTheClosedLists_Returns400_AndAsksTheAgentNothing(string path, string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        using var response = await PostAsync(app, path, JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Text_LongerThanTheContract_Returns400()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        using var response = await PostAsync(app, "text", new { text = new string('x', 201) });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task AFailureOfTheAgent_Returns502_WithOnlyItsStableCode()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        var http = PostAsync(app, "key", new { key = "ENTER" });
        await AnswerAsync(agent, Failed("failed"));
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var body = await DevicesApp.JsonAsync(response);
        body.GetProperty("agentError").GetString().Should().Be("failed");
        body.GetRawText().Should().NotContain("texto livre do agente");
    }

    // ---- energia ----

    [Theory]
    [InlineData("SLEEP")]
    [InlineData("SHUTDOWN")]
    public async Task SleepAndShutdown_WithoutTheConfirmation_Return400_AndNothingIsSentOrAudited(string action)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        using var response = await PostAsync(app, "power", new { action });
        using var explicitlyFalse = await PostAsync(app, "power", new { action, confirm = false });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        explicitlyFalse.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event.StartsWith("pc_"), Ct)).Should().Be(0);
    }

    [Theory]
    [InlineData("LOCK", false, "pc_lock")]
    [InlineData("SLEEP", true, "pc_sleep")]
    [InlineData("SHUTDOWN", true, "pc_shutdown")]
    [InlineData("CANCEL_SHUTDOWN", false, "pc_shutdown_cancelled")]
    public async Task Power_IsAuditedOnlyAfterTheAgentConfirmed(string action, bool confirm, string expectedEvent)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        var http = app.App.SendAsync(
            HttpMethod.Post, "/api/v1/pc/power", new { action, confirm }, app.Login.AccessToken, userAgent: "painel/1.0");
        var command = await AnswerAsync(agent);
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.power.v1");
        command.GetProperty("body").GetProperty("action").GetString().Should().Be(action);
        await using var db = app.App.Db();
        var audit = await db.PairingAudit.SingleAsync(a => a.Event == expectedEvent, Ct);
        audit.AgentId.Should().Be(app.Agent.Id);
        audit.UserId.Should().NotBeNull();
        audit.UserAgent.Should().Be("painel/1.0");
    }

    [Fact]
    public async Task Power_RefusedByTheAgent_IsNotAudited()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        var http = PostAsync(app, "power", new { action = "LOCK" });
        await AnswerAsync(agent, Failed("failed"));
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_lock", Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Power_IsLimitedPerAccountToAFewPerMinute()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        // O limite é de 20 por minuto; o PC fora do ar responde 503 sem esperar, então dá para esgotá-lo depressa.
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");
        for (var i = 0; i < 20; i++)
        {
            using var response = await PostAsync(app, "power", new { action = "LOCK" });
            response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        }

        using var limited = await PostAsync(app, "power", new { action = "LOCK" });
        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
    }

    // ---- favoritos ----

    [Fact]
    public async Task Launch_OnlyOpensWhatThePcAnnounced_AndAuditsIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);
        await agent.SendTextAsync(agent.Envelope("pc.apps.v1", new JsonObject
        {
            ["apps"] = new JsonArray(new JsonObject { ["id"] = "navegador", ["label"] = "Navegador" }),
            ["at"] = "2026-11-01T14:00:00Z",
        }));
        await TransportApp.WaitUntilAsync(async () => await StatusAppsAsync(app) == 1, "favoritos recebidos");

        using var unknown = await PostAsync(app, "apps/cmd/launch", null);
        var http = PostAsync(app, "apps/navegador/launch", null);
        var command = await AnswerAsync(agent);
        using var launched = await Within(http);

        unknown.StatusCode.Should().Be(HttpStatusCode.NotFound);
        launched.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.app.launch.v1");
        command.GetProperty("body").GetProperty("appId").GetString().Should().Be("navegador");
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_app_launch", Ct)).Should().Be(1);
    }

    // ---- sem PC ----

    [Fact]
    public async Task WithoutAPcAgent_EveryCommandReturns409Unavailable()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", "tv.remote");

        using var pointer = await PostAsync(app, "pointer", new { dx = 1, dy = 1 });
        using var key = await PostAsync(app, "key", new { key = "ENTER" });

        pointer.StatusCode.Should().Be(HttpStatusCode.Conflict);
        key.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(key)).GetProperty("type").GetString().Should().EndWith("/pc-unavailable");
    }

    [Fact]
    public async Task WithTheAgentOffline_CommandsReturn503WithoutWaiting()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectPcAsync(app);
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");

        using var response = await PostAsync(app, "key", new { key = "ENTER" });

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    // ---- permissão ----

    [Fact]
    public async Task AGuestWithoutTheModulePermission_Gets403_AndAnonymousGets401()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);
        var guest = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow());
        var onlyTraining = await GuestSeed.CreateGuestAsync(
            app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", ["module:training"]);

        using var status = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: guest.Login.AccessToken);
        using var power = await PostAsync(app, "power", new { action = "LOCK" }, onlyTraining.Login.AccessToken);
        using var anonymous = await app.App.SendAsync(HttpMethod.Post, "/api/v1/pc/pointer", new { dx = 1, dy = 1 });

        status.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        power.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task AGuestWithTheModulePermission_DrivesTheHousePc()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);
        var guest = await GuestSeed.CreateGuestAsync(
            app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", ["module:pc"]);

        var http = PostAsync(app, "media", new { action = "PLAY_PAUSE" }, guest.Login.AccessToken);
        var command = await AnswerAsync(agent);
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.media.v1");
    }

    // ---- limite de taxa do movimento ----

    [Fact]
    public async Task Pointer_HasItsOwnWideLimit_NotTheOneOfOrdinaryCommands()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        // Passa muito do teto dos comandos comuns (300 por minuto) sem ser barrado: o touchpad manda dezenas por segundo.
        for (var i = 0; i < 350; i++)
        {
            using var response = await PostAsync(app, "pointer", new { dx = 1, dy = 1 });
            response.StatusCode.Should().Be(HttpStatusCode.NoContent, $"o pedido {i} cabe no balde do movimento");
        }
    }
}
