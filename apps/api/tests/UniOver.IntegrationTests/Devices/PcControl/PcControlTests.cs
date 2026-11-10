using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Features.PcControl;

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
    private const string KeyV2 = "pc.key.v2";
    private const string TextV2 = "pc.text.v2";
    private const string ClickV2 = "pc.click.v2";
    private const string Zoom = "pc.pointer.zoom.v1";
    private const string Volume = "pc.volume.v1";

    private static readonly string[] Ctrl = ["CTRL"];
    private static readonly string[] CtrlShift = ["CTRL", "SHIFT"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Compara o JSON pelo conteúdo: a ordem das propriedades é a do gerador, não do contrato.</summary>
    private static void SameJson(JsonElement actual, string expected) =>
        System.Text.Json.Nodes.JsonNode.DeepEquals(System.Text.Json.Nodes.JsonNode.Parse(actual.GetRawText()), System.Text.Json.Nodes.JsonNode.Parse(expected))
            .Should().BeTrue($"o corpo devia ser {expected} e foi {actual.GetRawText()}");

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

    /// <summary>O PC anuncia o favorito "navegador", como o agente faz ao conectar.</summary>
    private static async Task AnnounceAppAsync(TransportApp app, FakeAgent agent)
    {
        await agent.SendTextAsync(agent.Envelope("pc.apps.v1", new JsonObject
        {
            ["apps"] = new JsonArray(new JsonObject { ["id"] = "navegador", ["label"] = "Navegador" }),
            ["at"] = "2026-11-01T14:00:00Z",
        }));
        await TransportApp.WaitUntilAsync(async () => await StatusAppsAsync(app) == 1, "favoritos recebidos");
    }

    /// <summary>O relógio é falso: sem resposta do agente, a espera só acaba quando o teste o avança além do prazo.</summary>
    private static async Task AdvanceUntilDoneAsync(TransportApp app, Task pending)
    {
        for (var i = 0; i < 200 && !pending.IsCompleted; i++)
        {
            app.App.Time.Advance(TimeSpan.FromSeconds(11));
            await Task.Delay(25, Ct);
        }

        pending.IsCompleted.Should().BeTrue("o prazo do comando já devia ter estourado");
    }

    private static Task AnnounceVolumeAsync(FakeAgent agent, int level, bool muted) =>
        agent.SendTextAsync(agent.Envelope("pc.volume.state.v1", new JsonObject
        {
            ["level"] = level,
            ["muted"] = muted,
            ["at"] = "2026-11-09T14:00:00Z",
        }));

    private static async Task<(int Level, bool Muted)?> VolumeOfStatusAsync(TransportApp app)
    {
        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);
        var volume = (await DevicesApp.JsonAsync(response)).GetProperty("volume");
        return volume.ValueKind == JsonValueKind.Null ? null : (volume.GetProperty("level").GetInt32(), volume.GetProperty("muted").GetBoolean());
    }

    private static async Task<bool> StatusOnlineAsync(TransportApp app)
    {
        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);
        return (await DevicesApp.JsonAsync(response)).GetProperty("online").GetBoolean();
    }

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

    [Fact]
    public async Task Status_ListsTheOptionalPcCapabilitiesTheAgentDeclared_AndNeverTheBaseOne()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);

        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);
        var body = await DevicesApp.JsonAsync(response);

        body.GetProperty("capabilities").EnumerateArray().Select(c => c.GetString()).Should().Equal(KeyV2);
    }

    [Fact]
    public async Task Status_HasNoVolume_UntilTheAgentAnnouncesIt_AndThenShowsTheLastOne()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, Volume);

        using var before = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);
        (await DevicesApp.JsonAsync(before)).GetProperty("volume").ValueKind.Should().Be(JsonValueKind.Null, "sem leitura nada se afirma");

        await AnnounceVolumeAsync(agent, 40, false);
        await TransportApp.WaitUntilAsync(async () => await VolumeOfStatusAsync(app) is not null, "volume recebido");
        (await VolumeOfStatusAsync(app))!.Value.Should().Be((40, false));

        await AnnounceVolumeAsync(agent, 65, true);
        await TransportApp.WaitUntilAsync(async () => await VolumeOfStatusAsync(app) is (65, true), "volume novo recebido");
    }

    [Fact]
    public async Task Status_NeverShowsAVolumeOfAnAgentThatIsOffline()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, Volume);
        await AnnounceVolumeAsync(agent, 40, false);
        await TransportApp.WaitUntilAsync(async () => await VolumeOfStatusAsync(app) is not null, "volume recebido");

        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(async () => !await StatusOnlineAsync(app), "agente desconectado");

        (await VolumeOfStatusAsync(app)).Should().BeNull("o nível de antes da queda não é leitura de agora");
    }

    [Fact]
    public async Task Status_NeverShowsTheVolumeOfAPreviousSession_UntilTheReconnectedAgentAnnouncesAgain()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var first = await ConnectAsync(app, "transport.keepalive.v1", Capability, Volume);
        await AnnounceVolumeAsync(first, 20, false);
        await TransportApp.WaitUntilAsync(async () => await VolumeOfStatusAsync(app) is (20, false), "volume da primeira sessão");

        await first.DisposeAsync();
        await TransportApp.WaitUntilAsync(async () => !await StatusOnlineAsync(app), "agente desconectado");

        await using var second = await ConnectAsync(app, "transport.keepalive.v1", Capability, Volume);
        await TransportApp.WaitUntilAsync(async () => await StatusOnlineAsync(app), "agente de volta");
        (await VolumeOfStatusAsync(app)).Should().BeNull("o 20 era da sessão anterior: o PC pode ter mudado de volume enquanto caiu");

        await AnnounceVolumeAsync(second, 80, false);
        await TransportApp.WaitUntilAsync(async () => await VolumeOfStatusAsync(app) is (80, false), "volume da sessão nova");
    }

    [Fact]
    public async Task Status_OfAnAgentFromBeforeTheV2_HasNoCapabilities()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);

        (await DevicesApp.JsonAsync(response)).GetProperty("capabilities").GetArrayLength().Should().Be(0);
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
    public async Task Pointer_ThatDoesNotMove_IsStillForwardedToTheAgent_AsTheKeepAliveOfAHeldButton()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        using var response = await PostAsync(app, "pointer", new { dx = 0, dy = 0 });
        var command = (await Within(agent.ReceiveAsync()))!.Value;

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.pointer.v1");
        var body = command.GetProperty("body");
        (body.GetProperty("dx").GetInt32(), body.GetProperty("dy").GetInt32()).Should().Be((0, 0));
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event.StartsWith("pc_"), Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Pointer_AcceptsTheSequenceButDoesNotForwardItToAnAgentWithoutTheDirectChannel()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        // Um agente anterior tem o esquema fechado e recusaria a mensagem com `seq`: o campo não sai da API.
        using var numbered = await PostAsync(app, "pointer", new { dx = 3, dy = 1, seq = 4821 });
        var body = (await Within(agent.ReceiveAsync()))!.Value.GetProperty("body");

        numbered.StatusCode.Should().Be(HttpStatusCode.NoContent);
        body.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(["dx", "dy"]);
    }

    [Fact]
    public async Task EveryInput_CarriesItsSequenceToAnAgentThatDeclaresTheDirectChannel()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, "pc.rtc.v1");

        using var pointer = await PostAsync(app, "pointer", new { dx = 3, dy = 1, seq = 11 });
        pointer.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Within(agent.ReceiveAsync()))!.Value.GetProperty("body").GetProperty("seq").GetInt32().Should().Be(11);

        const string page = "3fa9c10d7be2465a";
        var sent = new (string Path, object Body, string Type)[]
        {
            ("click", new { button = "LEFT", seq = 12, epoch = page }, "pc.click.v1"),
            ("key", new { key = "C", modifiers = Ctrl, seq = 13, epoch = page }, "pc.key.v1"),
            ("key", new { key = "BACKSPACE", repeat = 3, seq = 14, epoch = page }, "pc.key.v2"),
            ("key/release", new { key = "CTRL", seq = 15, epoch = page }, "pc.key.v2"),
            ("text", new { text = "olá", seq = 16, epoch = page }, "pc.text.v1"),
            ("media", new { action = "MUTE", seq = 17, epoch = page }, "pc.media.v1"),
        };
        var expected = 12;
        foreach (var (path, body, type) in sent)
        {
            var posting = PostAsync(app, path, body);
            var command = await AnswerAsync(agent);
            using var response = await Within(posting);

            response.StatusCode.Should().Be(HttpStatusCode.NoContent, path);
            command.GetProperty("type").GetString().Should().Be(type);
            command.GetProperty("body").GetProperty("seq").GetInt32().Should().Be(expected++, path);
            command.GetProperty("body").GetProperty("epoch").GetString().Should().Be(page, path);
        }
    }

    [Fact]
    public async Task EveryInput_WithoutASequence_GoesAsBefore_EvenToAnAgentWithTheDirectChannel()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, "pc.rtc.v1");

        var posting = PostAsync(app, "click", new { button = "LEFT" });
        var command = await AnswerAsync(agent);
        using var response = await Within(posting);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("body").EnumerateObject().Select(p => p.Name).Should().NotContain(["seq", "epoch"]);
    }

    [Fact]
    public async Task EveryInput_DoesNotForwardTheSequenceToAnAgentWithoutTheDirectChannel()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);

        var posting = PostAsync(app, "text", new { text = "abc", seq = 9, epoch = "3fa9c10d7be2465a" });
        var command = await AnswerAsync(agent);
        using var response = await Within(posting);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("body").EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(["text"]);
    }

    [Theory]
    [InlineData("click", "{\"button\":\"LEFT\",\"seq\":-1}")]
    [InlineData("key", "{\"key\":\"C\",\"seq\":-1}")]
    [InlineData("key/release", "{\"key\":\"CTRL\",\"seq\":-1}")]
    [InlineData("text", "{\"text\":\"a\",\"seq\":-1}")]
    [InlineData("media", "{\"action\":\"MUTE\",\"seq\":-1}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"epoch\":\"ZZ-nao-e-hex\"}")]
    [InlineData("key", "{\"key\":\"C\",\"seq\":1,\"epoch\":\"3FA9C10D7BE2465A\"}")]
    [InlineData("key/release", "{\"key\":\"CTRL\",\"epoch\":\"3fa9c10d7be2465\"}")]
    [InlineData("text", "{\"text\":\"a\",\"epoch\":\"3fa9c10d7be2465a0\"}")]
    [InlineData("media", "{\"action\":\"MUTE\",\"epoch\":\"\"}")]
    public async Task AnInput_WithANegativeSequenceOrAMalformedEpoch_Returns400(string path, string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, "pc.rtc.v1");

        using var response = await PostAsync(app, path, JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Pointer_ManyRequestsAtOnce_AllReachTheAgent()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        var responses = await Task.WhenAll(Enumerable.Range(1, 20)
            .Select(i => PostAsync(app, "pointer", new { dx = i, dy = 0, seq = i })));
        var received = new List<int>();
        for (var i = 0; i < 20; i++)
        {
            received.Add((await Within(agent.ReceiveAsync()))!.Value.GetProperty("body").GetProperty("dx").GetInt32());
        }

        responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.NoContent);
        received.Should().BeEquivalentTo(Enumerable.Range(1, 20));
        foreach (var response in responses)
        {
            response.Dispose();
        }
    }

    [Fact]
    public async Task PointerLimit_AllowsTwoDevicesOfTheSameAccountDrivingAtFullRate()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        // Dois aparelhos a ~31 pedidos por segundo cada somam ~3 700 por minuto: o teto precisa passar disso com folga.
        var policy = app.App.Services.GetRequiredService<IOptionsMonitor<RateLimitPolicyOptions>>().Get(RateLimitPolicies.PcPointer);

        policy.Permitted.Should().BeGreaterThanOrEqualTo(6000);
        policy.WindowSeconds.Should().Be(60);
        policy.Partition.Should().Be("user");
    }

    [Fact]
    public async Task Pointer_AfterTheAgentIsRevoked_IsNeverDelivered_EvenWithTheCacheWarm()
    {
        var outbox = new OutboxClaimBarrier();
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { CommandInterceptor = outbox });
        await using var agent = await ConnectPcAsync(app);
        await app.App.WaitForOutboxAsync(expectedProcessed: 1);
        using var warm = await PostAsync(app, "pointer", new { dx = 1, dy = 1 });
        (await Within(agent.ReceiveAsync()))!.Value.GetProperty("type").GetString().Should().Be("pc.pointer.v1");
        warm.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // A sessão é fechada pelo próprio pedido de revogação, antes do evento: o evento só é tratado depois que a barreira
        // solta. Com ele travado, a sessão já caiu (e o cache ainda está quente); depois de solto, o cache é esquecido.
        outbox.Arm();
        using var revoke = await app.App.RevokeRawAsync(app.Login, app.Agent.Id, "teste");
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        await outbox.WaitForClaimAsync(Ct);

        // Com o evento ainda travado (o cache segue quente), um movimento não pode ser entregue nem dado como enviado: a
        // sessão já caiu, e é isso que o barra.
        using var whileBlocked = await PostAsync(app, "pointer", new { dx = 3, dy = 3 });
        whileBlocked.StatusCode.Should().NotBe(HttpStatusCode.NoContent);

        // Nada chegou ao agente depois da revogação: só o fechamento da sessão, sem nenhuma mensagem de movimento.
        var leftovers = new List<string>();
        while (await agent.ReceiveAsync() is { } message)
        {
            leftovers.Add(message.GetProperty("type").GetString()!);
        }

        leftovers.Should().NotContain("pc.pointer.v1");
        agent.Closed!.Description.Should().Be("revoked");

        outbox.Release();
        await app.App.WaitForOutboxAsync(expectedProcessed: 2);

        // O evento de revogação foi tratado: o invalidador esqueceu o cache, então o resolvedor lê o banco e não acha o
        // agente. Sem a invalidação a resposta seria "desconectado" (a lista guardada ainda o traria), e não "nenhum PC".
        using var after = await PostAsync(app, "pointer", new { dx = 2, dy = 2 });

        after.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(after)).GetProperty("type").GetString().Should().EndWith("/pc-unavailable");
    }

    [Theory]
    [InlineData("{\"dx\":2001,\"dy\":0}")]
    [InlineData("{\"dx\":1,\"dy\":1,\"seq\":-1}")]
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

    [Fact]
    public async Task Key_ThatFitsTheV1_GoesAsV1_EvenToAnAgentThatKnowsTheV2()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);

        var http = PostAsync(app, "key", new { key = "C", modifiers = Ctrl, repeat = 1, action = "PRESS" });
        var command = await AnswerAsync(agent);
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.key.v1");
        SameJson(command.GetProperty("body"), "{\"key\":\"C\",\"modifiers\":[\"CTRL\"]}");
    }

    [Fact]
    public async Task Key_ThatNeedsTheV2_GoesAsV2_ToAnAgentThatDeclaredIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);

        var repeated = PostAsync(app, "key", new { key = "BACKSPACE", repeat = 12 });
        var repeatedCommand = await AnswerAsync(agent);
        using var repeatedResponse = await Within(repeated);

        var held = PostAsync(app, "key", new { key = "ALT", action = "DOWN" });
        var heldCommand = await AnswerAsync(agent);
        using var heldResponse = await Within(held);

        var digit = PostAsync(app, "key", new { key = "D0", modifiers = Ctrl });
        var digitCommand = await AnswerAsync(agent);
        using var digitResponse = await Within(digit);

        new[] { repeatedResponse, heldResponse, digitResponse }.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.NoContent);
        repeatedCommand.GetProperty("type").GetString().Should().Be("pc.key.v2");
        SameJson(repeatedCommand.GetProperty("body"), "{\"key\":\"BACKSPACE\",\"repeat\":12}");
        heldCommand.GetProperty("type").GetString().Should().Be("pc.key.v2");
        SameJson(heldCommand.GetProperty("body"), "{\"key\":\"ALT\",\"action\":\"DOWN\"}");
        SameJson(digitCommand.GetProperty("body"), "{\"key\":\"D0\",\"modifiers\":[\"CTRL\"]}");
    }

    [Theory]
    [InlineData("{\"key\":\"BACKSPACE\",\"repeat\":5}")]
    [InlineData("{\"key\":\"ALT\",\"action\":\"DOWN\"}")]
    [InlineData("{\"key\":\"PRINT_SCREEN\"}")]
    [InlineData("{\"key\":\"D1\"}")]
    public async Task Key_ThatNeedsTheV2_Returns409KeyUnsupported_ForAnOlderAgent_AndNothingIsSent(string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));

        using var response = await PostAsync(app, "key", JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-key-unsupported");

        // O agente antigo segue servido pela v1: a primeira coisa que ele recebe é a próxima tecla, e não a recusada.
        var next = PostAsync(app, "key", new { key = "ENTER" });
        var command = await AnswerAsync(agent);
        using var nextResponse = await Within(next);
        nextResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.key.v1");
    }

    [Fact]
    public async Task Key_ThatNeedsTheV2_JustAfterTheHelloWithoutIt_AsksToTryAgain_NotToUpdateTheAgent()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        // O agente novo manda um segundo `hello` com a capacidade assim que a API a lista: nos primeiros segundos a falta dela
        // não quer dizer agente antigo.
        using var early = await PostAsync(app, "key", new { key = "BACKSPACE", repeat = 5 });

        early.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await DevicesApp.JsonAsync(early)).GetProperty("type").GetString().Should().EndWith("/agent-reconnecting");

        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));
        using var late = await PostAsync(app, "key", new { key = "BACKSPACE", repeat = 5 });
        late.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Key_ThatNeedsTheV2_NeverUsesTheCapabilitiesOfAPreviousHello_WhileTheAgentIsOnlyExpectedBack()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));
        // A presença o dá como esperado de volta, com as capacidades do `hello` de antes (que podem não ser as de agora).
        var presence = app.App.Services.GetRequiredService<UniOver.Modules.Devices.Ports.IPresenceStore>();
        presence.MarkExpectedBack(app.Agent.Slug, app.App.Time.GetUtcNow(), "0.1.0+3f2a9c1d4e5b");
        app.Presence.Get(app.Agent.Slug)!.Capabilities.Should().Contain(KeyV2, "é o que a presença guardou");

        using var v2 = await PostAsync(app, "key", new { key = "BACKSPACE", repeat = 5 });
        using var status = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);

        v2.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await DevicesApp.JsonAsync(v2)).GetProperty("type").GetString().Should().EndWith("/agent-reconnecting");
        (await DevicesApp.JsonAsync(status)).GetProperty("capabilities").GetArrayLength().Should().Be(0, "capacidade de outra sessão não vale");
    }

    [Fact]
    public async Task Key_Repeat_MustBeAJsonInteger_NotText()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);

        using var asText = await PostAsync(app, "key", JsonNode.Parse("{\"key\":\"BACKSPACE\",\"repeat\":\"5\"}"));
        using var asFraction = await PostAsync(app, "key", JsonNode.Parse("{\"key\":\"BACKSPACE\",\"repeat\":5.5}"));

        asText.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        asFraction.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Key_Repeat_CountsEveryPress_AgainstAPerAccountBudget_AndReleasingIsNeverCharged()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));

        // Cada pedido aperta 50 vezes: 120 pedidos são 6000 apertos, o teto do minuto; o 121º passa do teto.
        var budget = app.App.Services.GetRequiredService<PcKeyBudget>();
        budget.TryTake(await UserIdAsync(app), PcKeyBudget.PressesPerMinute - 50).Should().BeTrue();

        var within = PostAsync(app, "key", new { key = "BACKSPACE", repeat = 50 });
        await AnswerAsync(agent);
        using var okResponse = await Within(within);
        using var over = await PostAsync(app, "key", new { key = "BACKSPACE", repeat = 2 });

        okResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        over.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);

        // Soltar um modificador segurado nunca entra na conta, nem pela rota própria nem como `action: UP`.
        var release = PostAsync(app, "key/release", new { key = "ALT" });
        var releaseCommand = await AnswerAsync(agent);
        using var released = await Within(release);
        var up = PostAsync(app, "key", new { key = "ALT", action = "UP" });
        await AnswerAsync(agent);
        using var upResponse = await Within(up);

        released.StatusCode.Should().Be(HttpStatusCode.NoContent);
        upResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        releaseCommand.GetProperty("type").GetString().Should().Be("pc.key.v2");
        SameJson(releaseCommand.GetProperty("body"), "{\"key\":\"ALT\",\"action\":\"UP\"}");
    }

    [Fact]
    public async Task Key_Budget_IsOnlyChargedForWhatWasSent_AndRefundedOnA409Or503()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectPcAsync(app); // agente sem a v2
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));
        var budget = app.App.Services.GetRequiredService<PcKeyBudget>();
        var user = await UserIdAsync(app);

        // 409 (agente antigo): nada saiu, o gasto volta; muitas recusas seguidas nunca esgotam o teto.
        for (var i = 0; i < 130; i++)
        {
            using var refused = await PostAsync(app, "key", new { key = "BACKSPACE", repeat = 50 });
            refused.StatusCode.Should().Be(HttpStatusCode.Conflict);
        }

        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");
        for (var i = 0; i < 130; i++)
        {
            using var offline = await PostAsync(app, "key", new { key = "BACKSPACE", repeat = 50 });
            offline.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        }

        budget.TryTake(user, PcKeyBudget.PressesPerMinute).Should().BeTrue("nenhum aperto saiu: o teto está inteiro");
    }

    [Fact]
    public async Task Text_ThatFitsTheV1_GoesAsV1_EvenToAnAgentThatKnowsTheV2()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, TextV2);

        var http = PostAsync(app, "text", new { text = "olá", erase = 0 });
        var command = await AnswerAsync(agent);
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.text.v1");
        SameJson(command.GetProperty("body"), "{\"text\":\"olá\"}");
    }

    [Fact]
    public async Task Text_ThatErasesOrPressesAKey_GoesAsV2_ToAnAgentThatDeclaredIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, TextV2);

        var edit = PostAsync(app, "text", new { erase = 4, text = "olá", key = "ENTER" });
        var editCommand = await AnswerAsync(agent);
        using var editResponse = await Within(edit);
        var eraseOnly = PostAsync(app, "text", new { erase = 12 });
        var eraseCommand = await AnswerAsync(agent);
        using var eraseResponse = await Within(eraseOnly);
        var keyOnly = PostAsync(app, "text", new { key = "TAB" });
        var keyCommand = await AnswerAsync(agent);
        using var keyResponse = await Within(keyOnly);

        new[] { editResponse, eraseResponse, keyResponse }.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.NoContent);
        editCommand.GetProperty("type").GetString().Should().Be("pc.text.v2");
        SameJson(editCommand.GetProperty("body"), "{\"erase\":4,\"text\":\"olá\",\"key\":\"ENTER\"}");
        SameJson(eraseCommand.GetProperty("body"), "{\"erase\":12}");
        SameJson(keyCommand.GetProperty("body"), "{\"key\":\"TAB\"}");
    }

    [Theory]
    [InlineData("{\"erase\":3,\"text\":\"a\"}")]
    [InlineData("{\"text\":\"a\",\"key\":\"ENTER\"}")]
    [InlineData("{\"erase\":1}")]
    public async Task Text_ThatNeedsTheV2_Returns409Unsupported_ForAnOlderAgent_AndNothingIsSent(string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));

        using var response = await PostAsync(app, "text", JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-key-unsupported");

        // O agente anterior à v2 segue servido pela v1: a primeira coisa que ele recebe é o próximo texto, e não o recusado.
        var next = PostAsync(app, "text", new { text = "ok" });
        var command = await AnswerAsync(agent);
        using var nextResponse = await Within(next);
        nextResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.text.v1");
    }

    [Fact]
    public async Task Text_Erase_CountsEveryBackspaceAgainstTheKeyBudget_AndIsRefundedWhenNothingWasSent()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, TextV2);
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));
        var budget = app.App.Services.GetRequiredService<PcKeyBudget>();
        var user = await UserIdAsync(app);
        budget.TryTake(user, PcKeyBudget.PressesPerMinute - 201).Should().BeTrue();

        // 200 Backspaces e a tecla do fim são 201 apertos: cabem exatamente; o seguinte passa do teto.
        var within = PostAsync(app, "text", new { erase = 200, key = "ENTER" });
        await AnswerAsync(agent);
        using var okResponse = await Within(within);
        using var over = await PostAsync(app, "text", new { erase = 1 });
        // O texto puro nunca paga: segue passando mesmo com o teto cheio.
        var plain = PostAsync(app, "text", new { text = "abc" });
        await AnswerAsync(agent);
        using var plainResponse = await Within(plain);

        okResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        over.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        plainResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Text_Erase_IsRefunded_OnA409OrA503_BecauseNothingWasSent()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectPcAsync(app); // agente sem a v2
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));
        var budget = app.App.Services.GetRequiredService<PcKeyBudget>();
        var user = await UserIdAsync(app);

        for (var i = 0; i < 60; i++)
        {
            using var refused = await PostAsync(app, "text", new { erase = 200 });
            refused.StatusCode.Should().Be(HttpStatusCode.Conflict);
        }

        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");
        for (var i = 0; i < 60; i++)
        {
            using var offline = await PostAsync(app, "text", new { erase = 200 });
            offline.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        }

        budget.TryTake(user, PcKeyBudget.PressesPerMinute).Should().BeTrue("nenhum aperto saiu: o teto está inteiro");
    }

    [Fact]
    public async Task Click_ThatFitsTheV1_GoesAsV1_EvenToAnAgentThatKnowsTheV2()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, ClickV2);

        var http = PostAsync(app, "click", new { button = "LEFT", action = "DOUBLE", modifiers = Array.Empty<string>(), gapMs = 0 });
        var command = await AnswerAsync(agent);
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.click.v1");
        SameJson(command.GetProperty("body"), "{\"button\":\"LEFT\",\"action\":\"DOUBLE\"}");
    }

    [Fact]
    public async Task Click_WithModifiersOrAGap_GoesAsV2_ToAnAgentThatDeclaredIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, ClickV2);

        var withModifiers = PostAsync(app, "click", new { button = "LEFT", modifiers = CtrlShift });
        var modifiersCommand = await AnswerAsync(agent);
        using var modifiersResponse = await Within(withModifiers);
        var withGap = PostAsync(app, "click", new { button = "LEFT", gapMs = 140 });
        var gapCommand = await AnswerAsync(agent);
        using var gapResponse = await Within(withGap);

        new[] { modifiersResponse, gapResponse }.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.NoContent);
        modifiersCommand.GetProperty("type").GetString().Should().Be("pc.click.v2");
        SameJson(modifiersCommand.GetProperty("body"), "{\"button\":\"LEFT\",\"modifiers\":[\"CTRL\",\"SHIFT\"]}");
        SameJson(gapCommand.GetProperty("body"), "{\"button\":\"LEFT\",\"gapMs\":140}");
    }

    [Theory]
    [InlineData("{\"button\":\"LEFT\",\"modifiers\":[\"CTRL\"]}")]
    [InlineData("{\"button\":\"LEFT\",\"gapMs\":120}")]
    public async Task Click_ThatNeedsTheV2_Returns409Unsupported_ForAnOlderAgent_AndNothingIsSent(string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));

        using var response = await PostAsync(app, "click", JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-key-unsupported");

        var next = PostAsync(app, "click", new { button = "LEFT" });
        var command = await AnswerAsync(agent);
        using var nextResponse = await Within(next);
        nextResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.click.v1");
    }

    [Fact]
    public async Task Zoom_GoesAsItsOwnMessage_ToAnAgentThatDeclaredIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, Zoom);

        var posting = PostAsync(app, "zoom", new { steps = -3 });
        var command = await AnswerAsync(agent);
        using var response = await Within(posting);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.pointer.zoom.v1");
        SameJson(command.GetProperty("body"), "{\"steps\":-3}");
    }

    [Fact]
    public async Task Volume_GoesAsItsOwnMessage_ToAnAgentThatDeclaredIt_WithOnlyWhatWasAsked()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, Volume);

        var level = PostAsync(app, "volume", new { level = 35 });
        var levelCommand = await AnswerAsync(agent);
        using var levelResponse = await Within(level);
        var both = PostAsync(app, "volume", new { level = 0, muted = true });
        var bothCommand = await AnswerAsync(agent);
        using var bothResponse = await Within(both);

        new[] { levelResponse, bothResponse }.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.NoContent);
        levelCommand.GetProperty("type").GetString().Should().Be("pc.volume.v1");
        SameJson(levelCommand.GetProperty("body"), "{\"level\":35}");
        SameJson(bothCommand.GetProperty("body"), "{\"level\":0,\"muted\":true}");
    }

    [Theory]
    [InlineData("zoom", "{\"steps\":2}")]
    [InlineData("volume", "{\"level\":20}")]
    [InlineData("volume", "{\"muted\":true}")]
    public async Task ZoomAndVolume_Return409Unsupported_ForAnAgentThatDidNotDeclareThem_AndNothingIsSent(string path, string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        // O agente declara só o que tinha antes: o esquema fechado dele recusaria a mensagem nova, e o toque ficaria morto.
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, TextV2, ClickV2);
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));

        using var response = await PostAsync(app, path, JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-key-unsupported");

        // Nada chegou ao agente: o próximo comando que ele recebe é o de uma tecla comum.
        var next = PostAsync(app, "key", new { key = "A" });
        var command = await AnswerAsync(agent);
        using var nextResponse = await Within(next);
        nextResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("type").GetString().Should().Be("pc.key.v1");
    }

    [Theory]
    [InlineData("zoom", "{\"steps\":2}")]
    [InlineData("volume", "{\"level\":20}")]
    public async Task ZoomAndVolume_JustAfterTheHelloWithoutThem_AskToTryAgain_NotToUpdateTheAgent(string path, string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);

        using var response = await PostAsync(app, path, JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-reconnecting");
    }

    [Fact]
    public async Task ZoomAndVolume_CarryTheirSequenceAndEpoch_OnlyToAnAgentThatDeclaresTheDirectChannel()
    {
        const string page = "3fa9c10d7be2465a";
        await using (var app = await TransportApp.StartAsync(postgres))
        {
            await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, Zoom, Volume, "pc.rtc.v1");
            var sent = new (string Path, object Body, string Type)[]
            {
                ("zoom", new { steps = 2, seq = 41, epoch = page }, "pc.pointer.zoom.v1"),
                ("volume", new { level = 12, seq = 42, epoch = page }, "pc.volume.v1"),
            };
            var expected = 41;
            foreach (var (path, body, type) in sent)
            {
                var posting = PostAsync(app, path, body);
                var command = await AnswerAsync(agent);
                using var response = await Within(posting);

                response.StatusCode.Should().Be(HttpStatusCode.NoContent, path);
                command.GetProperty("type").GetString().Should().Be(type);
                command.GetProperty("body").GetProperty("seq").GetInt32().Should().Be(expected++, path);
                command.GetProperty("body").GetProperty("epoch").GetString().Should().Be(page, path);
            }
        }

        await using var older = await TransportApp.StartAsync(postgres);
        await using var withoutDirect = await ConnectAsync(older, "transport.keepalive.v1", Capability, Zoom, Volume);
        var zoom = PostAsync(older, "zoom", new { steps = 1, seq = 9, epoch = page });
        var zoomCommand = await AnswerAsync(withoutDirect);
        using var zoomResponse = await Within(zoom);
        zoomResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);
        zoomCommand.GetProperty("body").EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(["steps"]);
    }

    [Theory]
    [InlineData("zoom", "{}")]
    [InlineData("zoom", "{\"steps\":0}")]
    [InlineData("zoom", "{\"steps\":13}")]
    [InlineData("zoom", "{\"steps\":-13}")]
    [InlineData("zoom", "{\"steps\":\"2\"}")]
    [InlineData("zoom", "{\"steps\":1.5}")]
    [InlineData("zoom", "{\"steps\":1,\"seq\":-1}")]
    [InlineData("zoom", "{\"steps\":1,\"seq\":\"7\"}")]
    [InlineData("zoom", "{\"steps\":1,\"seq\":7.5}")]
    [InlineData("zoom", "{\"steps\":1,\"epoch\":\"nao-e-hex\"}")]
    [InlineData("volume", "{}")]
    [InlineData("volume", "{\"level\":101}")]
    [InlineData("volume", "{\"level\":-1}")]
    [InlineData("volume", "{\"level\":\"20\"}")]
    [InlineData("volume", "{\"level\":40.5}")]
    [InlineData("volume", "{\"level\":10,\"seq\":-1}")]
    [InlineData("volume", "{\"level\":10,\"seq\":\"7\"}")]
    [InlineData("volume", "{\"level\":10,\"seq\":7.5}")]
    [InlineData("volume", "{\"muted\":true,\"epoch\":\"3FA9C10D7BE2465A\"}")]
    public async Task AZoomOrVolumeBodyOutsideTheContract_Returns400_AndAsksTheAgentNothing(string path, string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, Zoom, Volume, "pc.rtc.v1");

        using var response = await PostAsync(app, path, JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ZoomAndVolume_ToAnOfflineAgent_StillAnswerOffline_NotUnsupported()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, Zoom, Volume);
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(async () => !await StatusOnlineAsync(app), "agente desconectado");

        using var zoom = await PostAsync(app, "zoom", new { steps = 1 });
        using var volume = await PostAsync(app, "volume", new { level = 10 });

        zoom.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        volume.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task TheV2Inputs_CarryTheirSequenceAndEpoch_ToAnAgentThatDeclaresTheDirectChannel()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, TextV2, ClickV2, "pc.rtc.v1");

        const string page = "3fa9c10d7be2465a";
        var sent = new (string Path, object Body, string Type)[]
        {
            ("click", new { button = "LEFT", modifiers = Ctrl, gapMs = 100, seq = 31, epoch = page }, "pc.click.v2"),
            ("text", new { erase = 2, text = "ab", key = "ENTER", seq = 32, epoch = page }, "pc.text.v2"),
        };
        var expected = 31;
        foreach (var (path, body, type) in sent)
        {
            var posting = PostAsync(app, path, body);
            var command = await AnswerAsync(agent);
            using var response = await Within(posting);

            response.StatusCode.Should().Be(HttpStatusCode.NoContent, path);
            command.GetProperty("type").GetString().Should().Be(type);
            command.GetProperty("body").GetProperty("seq").GetInt32().Should().Be(expected++, path);
            command.GetProperty("body").GetProperty("epoch").GetString().Should().Be(page, path);
        }
    }

    [Theory]
    [InlineData("click", "{\"button\":\"LEFT\",\"modifiers\":[\"CTRL\",\"CTRL\"]}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"modifiers\":[\"META\"]}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"modifiers\":[\"WIN\"]}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"gapMs\":401}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"gapMs\":-1}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"gapMs\":\"120\"}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"action\":\"DOWN\",\"modifiers\":[\"CTRL\"]}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"action\":\"UP\",\"gapMs\":50}")]
    [InlineData("text", "{\"erase\":201}")]
    [InlineData("text", "{\"erase\":-1,\"text\":\"a\"}")]
    [InlineData("text", "{\"erase\":\"3\"}")]
    [InlineData("text", "{\"text\":\"a\",\"key\":\"ESCAPE\"}")]
    [InlineData("text", "{\"erase\":0}")]
    [InlineData("text", "{\"erase\":2,\"text\":\"a\\nb\"}")]
    public async Task AV2BodyOutsideTheContract_Returns400_AndAsksTheAgentNothing(string path, string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2, TextV2, ClickV2);

        using var response = await PostAsync(app, path, JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Key_Settle_CountsFromTheFirstHelloOfTheConnection_NotFromEveryReHello()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));

        // O agente repete o `hello` (a capacidade nova só vem depois da API listá-la): isso não reabre a espera.
        await agent.SendHelloAsync("0.1.0+3f2a9c1d4e5b", "transport.keepalive.v1", Capability);
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.LastMessageAt >= app.App.Time.GetUtcNow(), "segundo hello processado");

        using var response = await PostAsync(app, "key", new { key = "BACKSPACE", repeat = 5 });

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    private static async Task<Guid> UserIdAsync(TransportApp app)
    {
        await using var db = app.App.Db();
        return await db.Agents.Where(a => a.Slug == app.Agent.Slug).Select(a => a.PairedBy).SingleAsync(Ct);
    }

    [Theory]
    [InlineData("{\"key\":\"A\"}")]
    [InlineData("{\"key\":\"TAB\"}")]
    [InlineData("{}")]
    public async Task KeyRelease_OnlyReleasesAModifier(string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Capability, KeyV2);

        using var response = await PostAsync(app, "key/release", JsonNode.Parse(json));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task KeyRelease_ToAnOlderAgent_IsRefusedLikeAnyV2Key()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);
        app.App.Time.Advance(PcControlHandler.CapabilitySettle + TimeSpan.FromSeconds(1));

        using var response = await PostAsync(app, "key/release", new { key = "ALT" });

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Key_ThatNeedsTheV2_ToAnOfflineAgent_StillAnswersOfflineNotUnsupported()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectPcAsync(app);
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");

        using var response = await PostAsync(app, "key", new { key = "BACKSPACE", repeat = 5 });

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Theory]
    [InlineData("click", "{\"button\":\"BACK\"}")]
    [InlineData("click", "{\"button\":\"LEFT\",\"action\":\"TRIPLE\"}")]
    [InlineData("key", "{\"key\":\"F13\"}")]
    [InlineData("key", "{\"key\":\"BACKSPACE\",\"repeat\":0}")]
    [InlineData("key", "{\"key\":\"BACKSPACE\",\"repeat\":51}")]
    [InlineData("key", "{\"key\":\"ALT\",\"action\":\"HOLD\"}")]
    [InlineData("key", "{\"key\":\"A\",\"action\":\"DOWN\"}")]
    [InlineData("key", "{\"key\":\"ALT\",\"action\":\"DOWN\",\"modifiers\":[\"SHIFT\"]}")]
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
    public async Task Power_RefusedByTheAgent_IsAuditedAsAFailedAttempt_NotAsDone()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        var http = PostAsync(app, "power", new { action = "LOCK" });
        await AnswerAsync(agent, Failed("failed"));
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_lock", Ct)).Should().Be(0, "não foi feito");
        var attempt = await db.PairingAudit.SingleAsync(a => a.Event == "pc_lock_failed", Ct);
        attempt.AgentId.Should().Be(app.Agent.Id);
        attempt.UserId.Should().NotBeNull();
    }

    [Fact]
    public async Task Power_WithoutAnAnswerInTime_Returns504_AndTheAttemptIsAuditedBecauseTheAgentMayHaveActed()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        var http = PostAsync(app, "power", new { action = "SHUTDOWN", confirm = true });
        await Within(agent.ReceiveAsync());
        await AdvanceUntilDoneAsync(app, http);
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.GatewayTimeout);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_shutdown", Ct)).Should().Be(0);
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_shutdown_failed", Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Launch_RefusedByTheAgent_IsAuditedAsAFailedAttempt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);
        await AnnounceAppAsync(app, agent);

        var http = PostAsync(app, "apps/navegador/launch", null);
        await AnswerAsync(agent, Failed("unknown_app"));
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_app_launch", Ct)).Should().Be(0);
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_app_launch_failed", Ct)).Should().Be(1);
    }

    [Fact]
    public async Task APowerCommandWithNoLiveSession_SentNothing_SoLeavesNoAuditLine()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectPcAsync(app);
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");

        using var response = await PostAsync(app, "power", new { action = "SHUTDOWN", confirm = true });

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event.StartsWith("pc_"), Ct)).Should().Be(0);
    }

    [Fact]
    public async Task KeysRefusedByTheAgent_NeverEnterTheAuditTrail()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectPcAsync(app);

        var http = PostAsync(app, "key", new { key = "ENTER" });
        await AnswerAsync(agent, Failed("failed"));
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event.StartsWith("pc_"), Ct)).Should().Be(0);
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
        await AnnounceAppAsync(app, agent);

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
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-offline", "a presença já mostra a queda: é desconectado, não reconectando");
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
    public async Task AGuestWithTheModulePermissionButNoPcOfHisOwn_ReachesNoPc_NotEvenTheHouseOne()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var house = await ConnectPcAsync(app);
        var guest = await GuestSeed.CreateGuestAsync(
            app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", ["module:pc"]);

        using var status = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: guest.Login.AccessToken);
        using var media = await PostAsync(app, "media", new { action = "PLAY_PAUSE" }, guest.Login.AccessToken);
        using var pointer = await PostAsync(app, "pointer", new { dx = 5, dy = 5 }, guest.Login.AccessToken);
        using var power = await PostAsync(app, "power", new { action = "LOCK" }, guest.Login.AccessToken);

        status.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await DevicesApp.JsonAsync(status);
        body.GetProperty("available").GetBoolean().Should().BeFalse("o PC da casa não é dele");
        body.GetProperty("apps").GetArrayLength().Should().Be(0);
        media.StatusCode.Should().Be(HttpStatusCode.Conflict);
        pointer.StatusCode.Should().Be(HttpStatusCode.Conflict);
        power.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(media)).GetProperty("type").GetString().Should().EndWith("/pc-unavailable");
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event.StartsWith("pc_"), Ct)).Should().Be(0);
    }

    /// <summary>Pareia um PC para a convidada, pela aprovação dela mesma, e o conecta já com o controle do PC ligado.</summary>
    private static async Task<(FakeAgent Agent, string Slug, GuestSession Guest)> GuestWithOwnPcAsync(
        TransportApp app, string label, bool connected = true)
    {
        var guest = await app.App.NewGuestAsync(["module:tv", "module:pc"], label);
        await app.App.ConfirmWithPasswordAsync(guest);
        var started = await app.App.StartAsync($"PC de {label}");
        using var approved = await app.App.ApproveOwnRawAsync(guest.Login, new { userCode = started.UserCode, tvName = $"TV de {label}" });
        approved.StatusCode.Should().Be(HttpStatusCode.OK);
        using var poll = await app.App.PollRawAsync(started.PairingId, started.DeviceCode);
        var credentials = await DevicesApp.JsonAsync(poll);
        var slug = credentials.GetProperty("agentId").GetString()!;
        var agent = await FakeAgent.ConnectAsync(app.Server, slug, credentials.GetProperty("deviceToken").GetString()!);
        await agent.SendHelloAsync("0.1.0+3f2a9c1d4e5b", "transport.keepalive.v1", Capability);
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(slug)?.AgentVersion is not null, $"hello do PC de {label}");
        if (!connected)
        {
            await agent.DisposeAsync();
            await TransportApp.WaitUntilAsync(() => app.Presence.Get(slug)?.Connected == false, "queda registrada");
        }

        return (agent, slug, guest);
    }

    // ---- qual PC ----

    /// <summary>Cada pessoa só comanda o PC que ela mesma pareou: a convidada A não alcança o de B nem o do dono, e o dono não alcança os delas.</summary>
    [Fact]
    public async Task EachPersonOnlyDrivesHerOwnPc_NobodyReachesAnotherPersonsPc()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var house = await ConnectPcAsync(app);
        var (alice, aliceSlug, aliceGuest) = await GuestWithOwnPcAsync(app, "Alice");
        await using var aliceAgent = alice;
        var (bruno, brunoSlug, brunoGuest) = await GuestWithOwnPcAsync(app, "Bruno");
        await using var brunoAgent = bruno;

        var aliceCall = PostAsync(app, "media", new { action = "PLAY_PAUSE" }, aliceGuest.Login.AccessToken);
        var aliceCommand = await AnswerAsync(aliceAgent);
        using var aliceResponse = await Within(aliceCall);
        var brunoCall = PostAsync(app, "key", new { key = "ENTER" }, brunoGuest.Login.AccessToken);
        var brunoCommand = await AnswerAsync(brunoAgent);
        using var brunoResponse = await Within(brunoCall);
        var ownerCall = PostAsync(app, "media", new { action = "MUTE" });
        var ownerCommand = await AnswerAsync(house);
        using var ownerResponse = await Within(ownerCall);

        new[] { aliceResponse, brunoResponse, ownerResponse }.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.NoContent);
        aliceCommand.GetProperty("target").GetString().Should().Be($"agent:{aliceSlug}");
        brunoCommand.GetProperty("target").GetString().Should().Be($"agent:{brunoSlug}");
        ownerCommand.GetProperty("target").GetString().Should().Be($"agent:{app.Agent.Slug}");
    }

    [Fact]
    public async Task TheOwnerWithoutAPcOfHisOwn_NeverReachesAGuestsPc()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        // O PC do dono está conectado mas sem o controle do PC ligado: só o da convidada o tem.
        await using var house = await ConnectAsync(app, "transport.keepalive.v1", "tv.remote");
        var (alice, _, _) = await GuestWithOwnPcAsync(app, "Alice");
        await using var aliceAgent = alice;

        using var key = await PostAsync(app, "key", new { key = "ENTER" });
        using var status = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);

        key.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(status)).GetProperty("available").GetBoolean().Should().BeFalse();
    }

    /// <summary>Com o PC dela desligado a resposta é "desconectado": nada vai ao PC da casa, conectado.</summary>
    [Fact]
    public async Task WhenHerOwnPcIsOff_TheAnswerIs503_AndTheHousePcReceivesNothing()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var house = await ConnectPcAsync(app);
        var (own, _, guest) = await GuestWithOwnPcAsync(app, "Raphael", connected: false);
        await using var ownAgent = own;

        using var offline = await PostAsync(app, "media", new { action = "PLAY_PAUSE" }, guest.Login.AccessToken);
        using var status = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: guest.Login.AccessToken);

        offline.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        var body = await DevicesApp.JsonAsync(status);
        body.GetProperty("available").GetBoolean().Should().BeTrue();
        body.GetProperty("online").GetBoolean().Should().BeFalse();

        // O dono, que pareou o PC da casa, segue mandando nele.
        var mine = PostAsync(app, "media", new { action = "MUTE" });
        var houseCommand = await AnswerAsync(house);
        using var ok = await Within(mine);
        ok.StatusCode.Should().Be(HttpStatusCode.NoContent);
        houseCommand.GetProperty("target").GetString().Should().Be($"agent:{app.Agent.Slug}");
    }

    [Fact]
    public async Task AmongSeveralPcsOfTheSamePerson_TheConnectedOneWins()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var first = await ConnectPcAsync(app);
        await first.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");

        var second = await app.PairAnotherAsync("Segundo PC");
        await using var secondAgent = await FakeAgent.ConnectAsync(app.Server, second.Slug, second.Token);
        await secondAgent.SendHelloAsync("0.1.0+3f2a9c1d4e5b", "transport.keepalive.v1", Capability);
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(second.Slug)?.AgentVersion is not null, "hello do segundo PC");

        var http = PostAsync(app, "key", new { key = "ENTER" });
        var command = await AnswerAsync(secondAgent);
        using var response = await Within(http);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        command.GetProperty("target").GetString().Should().Be($"agent:{second.Slug}");
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

    // ---- queda do canal: o comando ao vivo espera só uma volta muito curta e nunca chega atrasado depois dela ----

    /// <summary>Espera o servidor perder a sessão (sem mandar comando: um pedido ao vivo logo depois da queda esperaria a volta do agente).</summary>
    private static async Task WaitUntilTheServerLostTheSessionAsync(TransportApp app)
    {
        var connections = app.App.Services.GetRequiredService<UniOver.Modules.Devices.Features.Agents.AgentConnections>();
        await TransportApp.WaitUntilAsync(() => !connections.TryGet(app.Agent.Slug, out _), "sessão encerrada no servidor");
    }

    /// <summary>
    /// Um comando ao vivo logo depois da queda (presença ainda na graça) espera a volta do agente por alguns segundos do relógio
    /// falso: o relógio anda até o pedido responder, e o que se confere é o que ele responde depois da espera.
    /// </summary>
    private static async Task<HttpResponseMessage> PostAcrossTheShortWaitAsync(TransportApp app, string path, object? body)
    {
        var post = PostAsync(app, path, body);
        using var giveUp = new CancellationTokenSource(FakeAgent.Patience);
        while (!post.IsCompleted)
        {
            app.App.Time.Advance(TimeSpan.FromSeconds(1));
            await Task.Delay(20, giveUp.Token);
        }

        return await post;
    }

    [Fact]
    public async Task InsideThePresenceGrace_EveryCommandFailsAs503AfterTheShortWait_AndNothingArrivesWhenThePcComesBack()
    {
        // Graça de presença ligada: o PC segue "verde" na tela depois da queda, que é quando o comando antigo ficava esperando.
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { PresenceGraceSeconds = 150 });
        var agent = await ConnectPcAsync(app);
        await AnnounceAppAsync(app, agent);
        await agent.DisposeAsync();
        await WaitUntilTheServerLostTheSessionAsync(app);
        app.Presence.Get(app.Agent.Slug)!.Connected.Should().BeTrue("a presença segue verde durante a graça");

        (string Path, object? Body)[] commands =
        [
            ("pointer", new { dx = 5, dy = 5 }),
            ("click", new { button = "LEFT" }),
            ("key", new { key = "ENTER" }),
            ("text", new { text = "olá" }),
            ("media", new { action = "VOLUME_UP" }),
            ("power", new { action = "SLEEP", confirm = true }),
            ("apps/navegador/launch", null),
        ];
        foreach (var (path, body) in commands)
        {
            // Espera só a volta curta (alguns segundos de relógio falso), não a janela de 25 s dos comandos da TV.
            using var response = await Within(PostAcrossTheShortWaitAsync(app, path, body));

            response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, path);
            (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-reconnecting", path);
        }

        await using var back = await ConnectPcAsync(app);
        // A graça de presença já mostra o PC conectado, então se espera a sessão nova de verdade: o pedido só passa (204) quando ela existe.
        await TransportApp.WaitUntilAsync(
            async () =>
            {
                using var afterwards = await PostAsync(app, "pointer", new { dx = 77, dy = 0 });
                return afterwards.StatusCode == HttpStatusCode.NoContent;
            },
            "sessão nova aceitando comandos");
        var first = (await Within(back.ReceiveAsync()))!.Value;

        first.GetProperty("type").GetString().Should().Be("pc.pointer.v1");
        first.GetProperty("body").GetProperty("dx").GetInt32().Should().Be(77, "nada do que foi pedido durante a queda é entregue depois");
    }

    [Fact]
    public async Task Pointer_WithNoLiveSession_FailsAs503_AfterOnlyTheShortWait()
    {
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { PresenceGraceSeconds = 150 });
        var agent = await ConnectPcAsync(app);
        await agent.DisposeAsync();
        await WaitUntilTheServerLostTheSessionAsync(app);

        using var zero = await Within(PostAcrossTheShortWaitAsync(app, "pointer", new { dx = 0, dy = 0 }));
        zero.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, "o sinal de vida também falha, depois da espera curta");
        using var response = await Within(PostAcrossTheShortWaitAsync(app, "pointer", new { dx = 9, dy = 9, scrollY = 120 }));

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/agent-reconnecting");
    }

    // ---- o texto digitado nunca vai a log nem a auditoria ----

    [Fact]
    public async Task TheTypedText_NeverReachesAnyLogLineOrAuditRow_WhateverHappensToTheCommand()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectPcAsync(app);
        var secret = "segredo-" + Guid.NewGuid().ToString("N");
        var bodies = new List<string>();

        // 1. O agente executa: o texto chega a ele (e só a ele).
        var done = PostAsync(app, "text", new { text = secret });
        var delivered = await AnswerAsync(agent);
        using var okResponse = await Within(done);
        delivered.GetProperty("body").GetProperty("text").GetString().Should().Be(secret);
        okResponse.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // 2. O agente recusa.
        var refused = PostAsync(app, "text", new { text = secret });
        await AnswerAsync(agent, Failed("failed"));
        using var refusedResponse = await Within(refused);
        bodies.Add(await refusedResponse.Content.ReadAsStringAsync(Ct));

        // 3. O agente não responde no prazo.
        var silent = PostAsync(app, "text", new { text = secret });
        await Within(agent.ReceiveAsync());
        await AdvanceUntilDoneAsync(app, silent);
        using var timedOut = await Within(silent);
        bodies.Add(await timedOut.Content.ReadAsStringAsync(Ct));

        // 4. O pedido é inválido (quebra de linha): recusado antes de sair da API.
        using var invalid = await PostAsync(app, "text", new { text = secret + "\n" });
        invalid.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        bodies.Add(await invalid.Content.ReadAsStringAsync(Ct));

        // 5. O PC está fora do ar.
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");
        using var offline = await PostAsync(app, "text", new { text = secret });
        offline.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        bodies.Add(await offline.Content.ReadAsStringAsync(Ct));

        refusedResponse.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        timedOut.StatusCode.Should().Be(HttpStatusCode.GatewayTimeout);
        bodies.Should().NotContain(b => b.Contains(secret, StringComparison.Ordinal), "nem a resposta devolve o texto");
        app.App.Logs.Lines.Should().NotBeEmpty("a captura de log estava ligada");
        app.App.Logs.Lines.Should().NotContain(l => l.Contains(secret, StringComparison.Ordinal), "o texto pode ser senha");

        await using var db = app.App.Db();
        var rows = await db.PairingAudit.AsNoTracking().ToListAsync(Ct);
        rows.Should().NotContain(r => r.Event.StartsWith("pc_", StringComparison.Ordinal), "texto não entra na trilha");
        JsonSerializer.Serialize(rows).Should().NotContain(secret);
    }

    // ---- limite de taxa: clique, tecla, texto e mídia têm balde próprio, acima dos 300 por minuto dos comandos comuns ----
    [Fact]
    public async Task ClickKeyTextAndMedia_ShareOneBucketOfSixHundredPerMinute_SeparateFromTheOrdinaryCommands()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectPcAsync(app);
        using var stop = new CancellationTokenSource();

        // O agente simulado atende todos os comandos, como o de verdade: o limite é provado com o PC no ar.
        var pump = Task.Run(
            async () =>
            {
                try
                {
                    while (!stop.IsCancellationRequested)
                    {
                        await AnswerAsync(agent);
                    }
                }
                catch (Exception ex) when (ex is OperationCanceledException or TimeoutException or InvalidOperationException or System.Net.WebSockets.WebSocketException or ObjectDisposedException)
                {
                    // Fim do teste: o servidor fechou o canal junto com o app.
                }
            },
            Ct);

        // 600 pedidos misturados passam do teto de 300 dos comandos comuns sem um 429: o volume segurado (uns 316 por minuto)
        // e as teclas repetidas moram todos neste balde.
        (string Path, object Body)[] inputs =
        [
            ("click", new { button = "LEFT" }),
            ("key", new { key = "ENTER" }),
            ("text", new { text = "a" }),
            ("media", new { action = "VOLUME_UP" }),
        ];
        for (var i = 0; i < 600; i++)
        {
            var (path, body) = inputs[i % inputs.Length];
            using var response = await PostAsync(app, path, body);
            response.StatusCode.Should().Be(HttpStatusCode.NoContent, $"o pedido {i} ({path}) cabe no balde de entrada do PC");
        }

        // O 601º, de qualquer um dos quatro, bate no teto: o balde é um só.
        using var limited = await PostAsync(app, "key", new { key = "ENTER" });
        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests, "o balde de entrada tem teto: 600 por minuto");

        // E o balde dos comandos comuns segue intacto: o estado ainda responde.
        using var status = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);
        status.StatusCode.Should().Be(HttpStatusCode.OK);

        // O agente e a bomba de respostas terminam com o app, que fecha o canal: fechar o agente aqui disputaria a leitura.
        await stop.CancelAsync();
    }
}
