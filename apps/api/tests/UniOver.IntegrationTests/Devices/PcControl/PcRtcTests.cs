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
/// O canal direto (WebRTC) do controle do PC: a API só faz a sinalização autenticada. Cobre o repasse da oferta ao agente pelo
/// canal que já existe (resposta e token de volta), que só o dono do PC abre o canal, a vida curta do token, o fechamento por
/// quem pediu ou pelo agente e a trilha, sem SDP nem token em lugar nenhum.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class PcRtcTests(PostgresFixture postgres)
{
    private const string Control = "pc.control.v1";
    private const string Rtc = "pc.rtc.v1";
    private const string FakeSdp =
        "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\n";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<FakeAgent> ConnectAsync(TransportApp app, params string[] capabilities)
    {
        var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("0.1.0+3f2a9c1d4e5b", capabilities);
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.AgentVersion is not null, "hello processado");
        return agent;
    }

    private static Task<FakeAgent> ConnectDirectAsync(TransportApp app) =>
        ConnectAsync(app, "transport.keepalive.v1", Control, Rtc);

    private static Task<HttpResponseMessage> PostAsync(TransportApp app, string path, object? body, string? token = null) =>
        app.App.SendAsync(HttpMethod.Post, $"/api/v1/pc/rtc/{path}", body, token ?? app.Login.AccessToken);

    /// <summary>O agente simulado atende a oferta como o de verdade: a resposta SDP primeiro, depois o resultado do comando.</summary>
    private static async Task<JsonElement> AnswerOfferAsync(FakeAgent agent, string answerSdp = "ANSWER-SDP", bool ok = true)
    {
        var command = (await agent.ReceiveAsync())!.Value;
        var body = command.GetProperty("body");
        if (ok)
        {
            await agent.SendTextAsync(agent.Envelope(
                "pc.rtc.answer.v1",
                new JsonObject { ["sessionId"] = body.GetProperty("sessionId").GetGuid(), ["sdp"] = answerSdp },
                command.GetProperty("id").GetGuid()));
        }

        var result = ok
            ? new JsonObject { ["ok"] = true }
            : new JsonObject { ["ok"] = false, ["error"] = new JsonObject { ["code"] = "rtc_unavailable", ["message"] = "texto livre" } };
        await agent.SendTextAsync(agent.Envelope("command.result.v1", result, command.GetProperty("id").GetGuid()));
        return command;
    }

    private static async Task<(JsonElement Answer, JsonElement Offer)> OpenAsync(
        TransportApp app, FakeAgent agent, bool replacing = false)
    {
        var posting = PostAsync(app, "offer", new { sdp = FakeSdp });
        if (replacing)
        {
            // Um canal já aberto: a API fecha o anterior (avisando o agente) antes de entregar a oferta nova.
            (await agent.ReceiveAsync())!.Value.GetProperty("type").GetString().Should().Be("pc.rtc.close.v1");
        }

        var offer = await AnswerOfferAsync(agent);
        using var response = await posting.WaitAsync(FakeAgent.Patience, Ct);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await DevicesApp.JsonAsync(response), offer);
    }

    // ---- a oferta ----

    [Fact]
    public async Task TheOffer_ReachesTheAgentOverTheExistingChannel_AndTheAnswerAndTokenComeBack()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        var (answer, offer) = await OpenAsync(app, agent);

        offer.GetProperty("type").GetString().Should().Be("pc.rtc.offer.v1");
        var sent = offer.GetProperty("body");
        sent.GetProperty("sdp").GetString().Should().Be(FakeSdp, "a oferta passa inteira, sem ser mexida");
        sent.GetProperty("tokenTtlSeconds").GetInt32().Should().Be(30);
        var token = sent.GetProperty("token").GetString()!;
        token.Should().MatchRegex("^[A-Za-z0-9_-]{43}$", "32 bytes aleatórios em base64url");
        answer.GetProperty("sdp").GetString().Should().Be("ANSWER-SDP");
        answer.GetProperty("token").GetString().Should().Be(token, "o mesmo token vai ao agente e ao app");
        answer.GetProperty("sessionId").GetGuid().Should().Be(sent.GetProperty("sessionId").GetGuid());
        answer.GetProperty("expiresInSeconds").GetInt32().Should().Be(30);
    }

    [Fact]
    public async Task EachOffer_GetsItsOwnTokenAndSession()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        var (first, _) = await OpenAsync(app, agent);
        var (second, _) = await OpenAsync(app, agent, replacing: true);

        second.GetProperty("token").GetString().Should().NotBe(first.GetProperty("token").GetString());
        second.GetProperty("sessionId").GetGuid().Should().NotBe(first.GetProperty("sessionId").GetGuid());
    }

    [Fact]
    public async Task TheStatus_ListsThePcRtcCapabilityOnlyWhenTheAgentDeclaresIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        using var response = await app.App.SendAsync(HttpMethod.Get, "/api/v1/pc/status", bearer: app.Login.AccessToken);
        var capabilities = (await DevicesApp.JsonAsync(response)).GetProperty("capabilities").EnumerateArray().Select(c => c.GetString());

        capabilities.Should().Contain(Rtc);
    }

    [Fact]
    public async Task AnAgentWithoutTheCapability_Gets409_AndNothingIsSentToIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Control);

        using var response = await PostAsync(app, "offer", new { sdp = FakeSdp });

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-direct-unavailable");
    }

    [Fact]
    public async Task WithNoPcAtAll_Gets409Unavailable()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", "tv.remote");

        using var response = await PostAsync(app, "offer", new { sdp = FakeSdp });

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-unavailable");
    }

    [Fact]
    public async Task APcThatIsOffline_Gets503()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await ConnectDirectAsync(app);
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda registrada");

        using var response = await PostAsync(app, "offer", new { sdp = FakeSdp });

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("isto não é um SDP")]
    [InlineData("v=0\r\nm=audio 9 RTP/AVP 0\r\n")]
    public async Task AnOfferThatIsNotADataChannelWithAFingerprint_Gets400_AndNeverReachesTheAgent(string? sdp)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        using var response = await PostAsync(app, "offer", new { sdp });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task AnOversizedOffer_Gets400()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        using var response = await PostAsync(app, "offer", new { sdp = FakeSdp + new string('x', 20_000) });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task WhenTheAgentRefuses_TheAppGets502WithOnlyTheStableCode_AndNoSessionStays()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        var posting = PostAsync(app, "offer", new { sdp = FakeSdp });
        await AnswerOfferAsync(agent, ok: false);
        using var response = await posting.WaitAsync(FakeAgent.Patience, Ct);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var body = await DevicesApp.JsonAsync(response);
        body.GetProperty("agentError").GetString().Should().Be("rtc_unavailable");
        body.ToString().Should().NotContain("texto livre");
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event.StartsWith("pc_direct"), Ct)).Should().Be(0);
    }

    // ---- só o dono ----

    [Fact]
    public async Task AGuestWithTheModulePermissionButNoPcOfHisOwn_CannotOpenAChannelToTheHousePc()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var house = await ConnectDirectAsync(app);
        var guest = await GuestSeed.CreateGuestAsync(
            app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", ["module:pc"]);

        using var response = await PostAsync(app, "offer", new { sdp = FakeSdp }, guest.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-unavailable");
    }

    [Fact]
    public async Task AGuestWithoutThePcModulePermission_Gets403_AndAnonymousGets401()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var onlyTraining = await GuestSeed.CreateGuestAsync(
            app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", ["module:training"]);

        using var forbidden = await PostAsync(app, "offer", new { sdp = FakeSdp }, onlyTraining.Login.AccessToken);
        using var anonymous = await app.App.SendAsync(HttpMethod.Post, "/api/v1/pc/rtc/offer", new { sdp = FakeSdp });

        forbidden.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task OnlyTheOwnerOfTheSession_CanSendCandidatesOrClose_ForAnotherPersonItDoesNotExist()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);
        var sessionId = answer.GetProperty("sessionId").GetGuid();
        var stranger = await GuestSeed.CreateGuestAsync(
            app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", ["module:pc"]);

        using var candidate = await PostAsync(
            app, $"{sessionId}/candidates", new { candidate = "candidate:1 1 udp 1 192.168.1.9 5000 typ host" }, stranger.Login.AccessToken);
        using var close = await PostAsync(app, $"{sessionId}/close", null, stranger.Login.AccessToken);

        candidate.StatusCode.Should().Be(HttpStatusCode.Gone);
        close.StatusCode.Should().Be(HttpStatusCode.NotFound);
        // A sessão segue viva para o dono.
        using var own = await PostAsync(app, $"{sessionId}/close", null);
        own.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    // ---- candidatos e a vida curta do token ----

    [Fact]
    public async Task ALateCandidate_IsRelayedToTheAgent_WhileTheNegotiationWindowIsOpen()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);
        var sessionId = answer.GetProperty("sessionId").GetGuid();

        using var response = await PostAsync(
            app, $"{sessionId}/candidates", new { candidate = "candidate:1 1 udp 1 192.168.1.9 5000 typ host", sdpMid = "0", sdpMLineIndex = 0 });
        var relayed = (await agent.ReceiveAsync())!.Value;

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        relayed.GetProperty("type").GetString().Should().Be("pc.rtc.candidate.v1");
        relayed.GetProperty("body").GetProperty("sessionId").GetGuid().Should().Be(sessionId);
        relayed.GetProperty("body").GetProperty("candidate").GetString().Should().StartWith("candidate:1");
    }

    [Fact]
    public async Task TheNegotiationWindowExpiresWithTheToken_AndALaterCandidateGets410()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);
        var sessionId = answer.GetProperty("sessionId").GetGuid();

        app.App.Time.Advance(TimeSpan.FromSeconds(31));
        using var response = await PostAsync(
            app, $"{sessionId}/candidates", new { candidate = "candidate:1 1 udp 1 192.168.1.9 5000 typ host" });

        response.StatusCode.Should().Be(HttpStatusCode.Gone);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-direct-expired");
    }

    [Theory]
    [InlineData("")]
    [InlineData("não-é-candidato")]
    public async Task AMalformedCandidate_Gets400(string candidate)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);

        using var response = await PostAsync(app, $"{answer.GetProperty("sessionId").GetGuid()}/candidates", new { candidate });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ACandidateForASessionThatNeverExisted_Gets410()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        using var response = await PostAsync(
            app, $"{Guid.NewGuid()}/candidates", new { candidate = "candidate:1 1 udp 1 192.168.1.9 5000 typ host" });

        response.StatusCode.Should().Be(HttpStatusCode.Gone);
    }

    // ---- fechar e a trilha ----

    [Fact]
    public async Task Closing_TellsTheAgent_AndTheTrailHasOneOpenedAndOneClosedLineWithNoSdpOrToken()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, offer) = await OpenAsync(app, agent);
        var sessionId = answer.GetProperty("sessionId").GetGuid();

        using var close = await PostAsync(app, $"{sessionId}/close", null);
        var told = (await agent.ReceiveAsync())!.Value;
        using var again = await PostAsync(app, $"{sessionId}/close", null);

        close.StatusCode.Should().Be(HttpStatusCode.NoContent);
        told.GetProperty("type").GetString().Should().Be("pc.rtc.close.v1");
        told.GetProperty("body").GetProperty("sessionId").GetGuid().Should().Be(sessionId);
        told.GetProperty("body").GetProperty("reason").GetString().Should().Be("requested");
        again.StatusCode.Should().Be(HttpStatusCode.NotFound, "fechar duas vezes grava uma linha só");
        await using var db = app.App.Db();
        var rows = await db.PairingAudit.Where(a => a.Event.StartsWith("pc_direct")).OrderBy(a => a.OccurredAt).ToListAsync(Ct);
        rows.Select(r => r.Event).Should().Equal("pc_direct_opened", "pc_direct_closed");
        rows.Should().OnlyContain(r => r.UserId != null && r.AgentId != null);
        JsonSerializer.Serialize(rows.Select(r => new { r.Event, r.Ip, r.UserAgent })).Should()
            .NotContain(offer.GetProperty("body").GetProperty("token").GetString()!)
            .And.NotContain("fingerprint");
    }

    [Fact]
    public async Task WhenTheAgentReportsTheChannelClosed_TheTrailGetsTheClosedLineOnce()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);
        var sessionId = answer.GetProperty("sessionId").GetGuid();

        var closed = agent.Envelope("pc.rtc.closed.v1", new JsonObject { ["sessionId"] = sessionId, ["reason"] = "idle" });
        await agent.SendTextAsync(closed);
        await agent.SendTextAsync(closed);
        await TransportApp.WaitUntilAsync(async () =>
        {
            await using var db = app.App.Db();
            return await db.PairingAudit.CountAsync(a => a.Event == "pc_direct_closed") >= 1;
        }, "fechamento gravado");

        await using var check = app.App.Db();
        (await check.PairingAudit.CountAsync(a => a.Event == "pc_direct_closed", Ct)).Should().Be(1);
        using var late = await PostAsync(app, $"{sessionId}/close", null);
        late.StatusCode.Should().Be(HttpStatusCode.NotFound, "a sessão já saiu da memória");
    }

    [Fact]
    public async Task AClosedReportForASessionThatIsNotTheAgents_IsIgnored()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        await agent.SendTextAsync(agent.Envelope("pc.rtc.closed.v1", new JsonObject { ["sessionId"] = Guid.NewGuid(), ["reason"] = "idle" }));
        await Task.Delay(300, Ct);

        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event.StartsWith("pc_direct"), Ct)).Should().Be(0);
    }

    [Fact]
    public async Task ANewOffer_ReplacesTheOpenChannel_TheAgentIsToldAndTheOldSessionIsGone()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (first, _) = await OpenAsync(app, agent);
        var firstId = first.GetProperty("sessionId").GetGuid();

        var posting = PostAsync(app, "offer", new { sdp = FakeSdp });
        var replaced = (await agent.ReceiveAsync())!.Value;
        await AnswerOfferAsync(agent);
        using var second = await posting.WaitAsync(FakeAgent.Patience, Ct);

        second.StatusCode.Should().Be(HttpStatusCode.OK);
        replaced.GetProperty("type").GetString().Should().Be("pc.rtc.close.v1");
        replaced.GetProperty("body").GetProperty("sessionId").GetGuid().Should().Be(firstId);
        replaced.GetProperty("body").GetProperty("reason").GetString().Should().Be("replaced");
        using var oldClose = await PostAsync(app, $"{firstId}/close", null);
        oldClose.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task WhenTheReplacementOfferFails_TheClosedLineOfTheOldChannelIsStillRecorded()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        await OpenAsync(app, agent);

        var posting = PostAsync(app, "offer", new { sdp = FakeSdp });
        (await agent.ReceiveAsync())!.Value.GetProperty("type").GetString().Should().Be("pc.rtc.close.v1");
        await AnswerOfferAsync(agent, ok: false);
        using var response = await posting.WaitAsync(FakeAgent.Patience, Ct);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        await using var db = app.App.Db();
        var events = await db.PairingAudit.Where(a => a.Event.StartsWith("pc_direct")).Select(a => a.Event).ToListAsync(Ct);
        events.Should().BeEquivalentTo(["pc_direct_opened", "pc_direct_closed"]);
    }

    [Fact]
    public async Task TheOfferRoutes_HaveTheirOwnRateLimit()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 25; i++)
        {
            using var response = await PostAsync(app, $"{Guid.NewGuid()}/close", null);
            statuses.Add(response.StatusCode);
        }

        statuses.Should().Contain(HttpStatusCode.TooManyRequests);
        statuses.Take(20).Should().OnlyContain(s => s == HttpStatusCode.NotFound);
    }
}
