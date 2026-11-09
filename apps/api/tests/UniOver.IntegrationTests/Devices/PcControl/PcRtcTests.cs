using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.Modules.Devices.Features.PcControl;
using UniOver.Modules.Identity.Contracts;
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

    // ---- o canal não sobrevive à sessão que o autorizou ----

    private static readonly string[] OnlyTv = ["module:tv"];

    private static readonly string[] OnlyPc = ["module:pc"];

    private static Guid SessionOf(LoggedIn login) =>
        Guid.Parse(new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().ReadJsonWebToken(login.AccessToken).GetClaim("sid").Value);

    private static async Task ExpectRevokedCloseAsync(FakeAgent agent, Guid sessionId)
    {
        var told = (await agent.ReceiveAsync())!.Value;
        told.GetProperty("type").GetString().Should().Be("pc.rtc.close.v1");
        told.GetProperty("body").GetProperty("sessionId").GetGuid().Should().Be(sessionId);
        told.GetProperty("body").GetProperty("reason").GetString().Should().Be("revoked");
    }

    /// <summary>
    /// Prova que o canal NÃO foi fechado pela API: o próximo aviso que o agente recebe é o fechamento pedido agora pelo dono
    /// (<c>requested</c>), e não um <c>revoked</c> antes dele. Sem esperar por "nada chegar" (que não prova nada).
    /// </summary>
    private static async Task ExpectStillOpenAsync(TransportApp app, FakeAgent agent, Guid sessionId)
    {
        using var close = await PostAsync(app, $"{sessionId}/close", null, app.Login.AccessToken);
        close.StatusCode.Should().Be(HttpStatusCode.NoContent, "a sessão seguia aberta para o dono");
        var told = (await agent.ReceiveAsync())!.Value;
        told.GetProperty("body").GetProperty("sessionId").GetGuid().Should().Be(sessionId);
        told.GetProperty("body").GetProperty("reason").GetString().Should().Be("requested");
    }

    private static async Task<Guid> OwnerIdAsync(TransportApp app)
    {
        await using var db = app.App.Db();
        return await db.PairingAudit.Where(a => a.Event == "pc_direct_opened").Select(a => a.UserId!.Value).FirstAsync(Ct);
    }

    [Fact]
    public async Task TheOffer_CarriesTheLifetimeOfTheAccessTokenThatAuthorizedIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        var (_, offer) = await OpenAsync(app, agent);

        var lifetime = offer.GetProperty("body").GetProperty("maxLifetimeSeconds").GetInt32();
        lifetime.Should().BeInRange(60, 600, "o que resta do token de acesso (uns 10 min), não o teto de quando a claim some");
    }

    [Fact]
    public async Task LoggingOutTheSessionThatOpenedTheChannel_ClosesItAtOnce_WithTheRevokedReasonAndTheTrail()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);
        var sessionId = answer.GetProperty("sessionId").GetGuid();

        using var logout = await app.App.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: app.Login.AccessToken);

        logout.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await ExpectRevokedCloseAsync(agent, sessionId);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_direct_closed", Ct)).Should().Be(1);
    }

    [Fact]
    public async Task LoggingOutAnotherSession_LeavesTheChannelAlone()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var other = await app.App.LoginAsync();
        var (answer, _) = await OpenAsync(app, agent);

        using var logout = await app.App.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: other.AccessToken);

        logout.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await ExpectStillOpenAsync(app, agent, answer.GetProperty("sessionId").GetGuid());
    }

    [Fact]
    public async Task ChangingThePassword_ClosesTheChannelsOfTheOtherSessions_ButNotTheOneThatChangedIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var changer = await app.App.LoginAsync();
        var (answer, _) = await OpenAsync(app, agent);

        using var changed = await app.App.SendAsync(
            HttpMethod.Post, "/api/v1/identity/me/password",
            new { currentPassword = app.App.OwnerPassword, newPassword = "pw-" + Guid.NewGuid().ToString("N") },
            bearer: changer.AccessToken);

        changed.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await ExpectRevokedCloseAsync(agent, answer.GetProperty("sessionId").GetGuid());
    }

    [Fact]
    public async Task ChangingThePasswordFromTheSessionThatOpenedTheChannel_KeepsTheChannel()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);

        using var changed = await app.App.SendAsync(
            HttpMethod.Post, "/api/v1/identity/me/password",
            new { currentPassword = app.App.OwnerPassword, newPassword = "pw-" + Guid.NewGuid().ToString("N") },
            bearer: app.Login.AccessToken);

        changed.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await ExpectStillOpenAsync(app, agent, answer.GetProperty("sessionId").GetGuid());
    }

    [Theory]
    [InlineData(UserAccessChangeKind.AccountDisabled, null)]
    [InlineData(UserAccessChangeKind.ModuleRemoved, "module:pc")]
    [InlineData(UserAccessChangeKind.SessionsEnded, null)]
    public async Task TheListener_ClosesTheChannelWhenTheAccountIsDisabledTheModuleIsRemovedOrAllSessionsEnd(
        UserAccessChangeKind kind, string? module)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);
        var userId = await OwnerIdAsync(app);

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var listener = scope.ServiceProvider.GetServices<IUserAccessListener>().OfType<PcRtcAccessListener>().Single();
            await listener.ChangedAsync(new UserAccessChange(userId, kind, Module: module), Ct);
        }

        await ExpectRevokedCloseAsync(agent, answer.GetProperty("sessionId").GetGuid());
    }

    [Fact]
    public async Task TheListener_IgnoresAnotherModule_AndAnotherPerson()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);
        var userId = await OwnerIdAsync(app);

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var listener = scope.ServiceProvider.GetServices<IUserAccessListener>().OfType<PcRtcAccessListener>().Single();
            await listener.ChangedAsync(new UserAccessChange(userId, UserAccessChangeKind.ModuleRemoved, Module: "module:tv"), Ct);
            await listener.ChangedAsync(new UserAccessChange(Guid.NewGuid(), UserAccessChangeKind.AccountDisabled), Ct);
        }

        await ExpectStillOpenAsync(app, agent, answer.GetProperty("sessionId").GetGuid());
    }

    // ---- as mesmas mudanças de acesso, pelas rotas de verdade do Identity (não só pelo ouvinte) ----

    [Fact]
    public async Task SigningOutOfAllOtherSessions_ThroughTheRoute_ClosesTheirChannels_ButNotTheCurrentOne()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var keeper = await app.App.LoginAsync();
        var (answer, _) = await OpenAsync(app, agent);
        var sessionId = answer.GetProperty("sessionId").GetGuid();

        using var revoked = await app.App.SendAsync(HttpMethod.Post, "/api/v1/identity/sessions/others/revoke", bearer: keeper.AccessToken);

        revoked.StatusCode.Should().BeOneOf(HttpStatusCode.NoContent, HttpStatusCode.OK);
        await ExpectRevokedCloseAsync(agent, sessionId);
    }

    [Fact]
    public async Task RevokingJustThatSession_ThroughTheRoute_ClosesItsChannel()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var other = await app.App.LoginAsync();
        var (answer, _) = await OpenAsync(app, agent);
        var openingSession = SessionOf(app.Login);

        using var revoked = await app.App.SendAsync(
            HttpMethod.Post, $"/api/v1/identity/sessions/{openingSession}/revoke", bearer: other.AccessToken);

        revoked.StatusCode.Should().BeOneOf(HttpStatusCode.NoContent, HttpStatusCode.OK);
        await ExpectRevokedCloseAsync(agent, answer.GetProperty("sessionId").GetGuid());
    }

    /// <summary>O convidado pareia o PRÓPRIO PC (com o canal direto) e abre um canal com a sessão dele.</summary>
    private static async Task<(FakeAgent Agent, GuestSession Guest, Guid ChannelId)> GuestWithChannelAsync(TransportApp app, string label)
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
        await agent.SendHelloAsync("0.1.0+3f2a9c1d4e5b", "transport.keepalive.v1", Control, Rtc);
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(slug)?.AgentVersion is not null, $"hello do PC de {label}");

        var posting = PostAsync(app, "offer", new { sdp = FakeSdp }, guest.Login.AccessToken);
        await AnswerOfferAsync(agent);
        using var response = await posting.WaitAsync(FakeAgent.Patience, Ct);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return (agent, guest, (await DevicesApp.JsonAsync(response)).GetProperty("sessionId").GetGuid());
    }

    [Fact]
    public async Task PausingTheGuest_ThroughTheRoute_ClosesTheChannelOfHisOwnPc()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var (agent, guest, channel) = await GuestWithChannelAsync(app, "Alice");
        await using var _ = agent;

        using var paused = await app.App.SendAsync(
            HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/pause", bearer: app.Login.AccessToken);

        paused.StatusCode.Should().BeOneOf(HttpStatusCode.NoContent, HttpStatusCode.OK);
        await ExpectRevokedCloseAsync(agent, channel);
    }

    [Fact]
    public async Task RevokingTheGuest_ThroughTheRoute_ClosesTheChannelOfHisOwnPc()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var (agent, guest, channel) = await GuestWithChannelAsync(app, "Bruno");
        await using var _ = agent;

        using var revoked = await app.App.SendAsync(
            HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke", bearer: app.Login.AccessToken);

        revoked.StatusCode.Should().BeOneOf(HttpStatusCode.NoContent, HttpStatusCode.OK);
        await ExpectRevokedCloseAsync(agent, channel);
    }

    private static async Task AllowPermissionsChangeAsync(TransportApp app)
    {
        // A confirmação (passkey) da troca de permissões: gravada direto, como os outros testes do Identity fazem.
        var ownerId = Guid.Parse(new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().ReadJsonWebToken(app.Login.AccessToken).Subject);
        await using var scope = app.App.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<UniOver.Modules.Identity.Persistence.IdentityDbContext>();
        db.StepUpConfirmations.Add(UniOver.Modules.Identity.Domain.StepUpConfirmation.Create(
            ownerId,
            SessionOf(app.Login),
            UniOver.Modules.Identity.Domain.StepUpActions.PermissionsChange,
            app.App.Time.GetUtcNow(),
            TimeSpan.FromMinutes(5)));
        await db.SaveChangesAsync(Ct);
    }

    [Fact]
    public async Task TakingTheModulePcAwayFromTheGuest_ThroughTheRoute_ClosesTheChannel()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var (agent, guest, channel) = await GuestWithChannelAsync(app, "Carla");
        await using var _ = agent;
        await AllowPermissionsChangeAsync(app);

        using var put = await app.App.SendAsync(
            HttpMethod.Put, $"/api/v1/identity/guests/{guest.UserId}/permissions", new { permissions = OnlyTv },
            bearer: app.Login.AccessToken);

        put.StatusCode.Should().Be(HttpStatusCode.OK, await put.Content.ReadAsStringAsync(Ct));
        await ExpectRevokedCloseAsync(agent, channel);
    }

    [Fact]
    public async Task TakingAnotherModuleAwayFromTheGuest_LeavesTheChannelAlone()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var (agent, guest, channel) = await GuestWithChannelAsync(app, "Davi");
        await using var _ = agent;
        await AllowPermissionsChangeAsync(app);

        using var put = await app.App.SendAsync(
            HttpMethod.Put, $"/api/v1/identity/guests/{guest.UserId}/permissions", new { permissions = OnlyPc },
            bearer: app.Login.AccessToken);

        put.StatusCode.Should().Be(HttpStatusCode.OK, await put.Content.ReadAsStringAsync(Ct));
        using var close = await PostAsync(app, $"{channel}/close", null, guest.Login.AccessToken);
        close.StatusCode.Should().Be(HttpStatusCode.NoContent, "a sessão seguia aberta para o convidado");
        var told = (await agent.ReceiveAsync())!.Value;
        told.GetProperty("body").GetProperty("reason").GetString().Should().Be("requested");
    }

    // ---- a rodada de revisão: oferta perdida na corrida, piso do token, aviso depois do commit ----

    private static async Task ReplyToOfferAsync(FakeAgent agent, JsonElement offer)
    {
        var id = offer.GetProperty("id").GetGuid();
        await agent.SendTextAsync(agent.Envelope(
            "pc.rtc.answer.v1",
            new JsonObject { ["sessionId"] = offer.GetProperty("body").GetProperty("sessionId").GetGuid(), ["sdp"] = "ANSWER-SDP" },
            id));
        await agent.SendTextAsync(agent.Envelope("command.result.v1", new JsonObject { ["ok"] = true }, id));
    }

    [Fact]
    public async Task AnOffer_WhoseSessionIsRevokedWhileItIsAnswered_Gets409_AndTheAgentIsToldToCloseItAgain()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var other = await app.App.LoginAsync();

        var posting = PostAsync(app, "offer", new { sdp = FakeSdp });
        var offer = (await agent.ReceiveAsync())!.Value;
        var sessionId = offer.GetProperty("body").GetProperty("sessionId").GetGuid();

        // A pessoa perde a sessão que pediu o canal enquanto o agente ainda atende a oferta.
        using var revoked = await app.App.SendAsync(
            HttpMethod.Post, $"/api/v1/identity/sessions/{SessionOf(app.Login)}/revoke", bearer: other.AccessToken);
        revoked.StatusCode.Should().BeOneOf(HttpStatusCode.NoContent, HttpStatusCode.OK);
        await ExpectRevokedCloseAsync(agent, sessionId);

        await ReplyToOfferAsync(agent, offer);
        using var response = await posting.WaitAsync(FakeAgent.Patience, Ct);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-direct-revoked");
        (await response.Content.ReadAsStringAsync(Ct)).Should().NotContain("ANSWER-SDP", "nada do canal chega a quem perdeu o acesso");
        await ExpectRevokedCloseAsync(agent, sessionId);
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_direct_opened", Ct)).Should().Be(0);
    }

    [Fact]
    public async Task TheOffer_IsRefusedWith401_WhenLessThanTheFloorRemainsOnTheAccessToken_AndGrantsWhatRemainsAboveIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        await using var scope = app.App.Services.CreateAsyncScope();
        var handler = scope.ServiceProvider.GetRequiredService<PcRtcHandler>();
        var client = new UniOver.Modules.Devices.Security.ClientInfo(null, null);
        var sdp = new PcRtcOfferRequest(FakeSdp);

        var refused = await handler.OfferAsync(Guid.NewGuid(), null, TimeSpan.FromSeconds(59), sdp, client, Ct);

        refused.Should().BeAssignableTo<Microsoft.AspNetCore.Http.IStatusCodeHttpResult>()
            .Which.StatusCode.Should().Be(401, "menos que o piso: nem o piso se concede");

        var userId = await OwnerIdAsyncFromToken(app);
        var offering = handler.OfferAsync(userId, null, TimeSpan.FromSeconds(75), sdp, client, Ct);
        var offer = await AnswerOfferAsync(agent);
        var granted = await offering.WaitAsync(FakeAgent.Patience, Ct);

        granted.Should().BeAssignableTo<Microsoft.AspNetCore.Http.IStatusCodeHttpResult>().Which.StatusCode.Should().Be(200);
        offer.GetProperty("body").GetProperty("maxLifetimeSeconds").GetInt32().Should().Be(75, "o que resta, sem arredondar para cima");
    }

    [Fact]
    public async Task AnOfferTheAgentRefusesAsClosed_Gets409PcDirectRevoked_NotAGenericFailure()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        var posting = PostAsync(app, "offer", new { sdp = FakeSdp });
        var offer = (await agent.ReceiveAsync())!.Value;
        // O fechamento da sessão chegou ao agente antes da oferta: ele a recusa com `rtc_closed`.
        await agent.SendTextAsync(agent.Envelope(
            "command.result.v1",
            new JsonObject { ["ok"] = false, ["error"] = new JsonObject { ["code"] = "rtc_closed", ["message"] = "texto livre" } },
            offer.GetProperty("id").GetGuid()));
        using var response = await posting.WaitAsync(FakeAgent.Patience, Ct);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pc-direct-revoked");
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_direct_opened", Ct)).Should().Be(0);
    }

    [Fact]
    public async Task AnOfferTheAgentRefusesForAnotherReason_KeepsTheGenericFailure()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);

        var posting = PostAsync(app, "offer", new { sdp = FakeSdp });
        await AnswerOfferAsync(agent, ok: false);
        using var response = await posting.WaitAsync(FakeAgent.Patience, Ct);

        response.StatusCode.Should().NotBe(HttpStatusCode.OK);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().NotEndWith("/pc-direct-revoked");
    }

    private static Task<Guid> OwnerIdAsyncFromToken(TransportApp app) =>
        Task.FromResult(Guid.Parse(new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().ReadJsonWebToken(app.Login.AccessToken).Subject));

    [Fact]
    public async Task TheListener_KeepsInTheRegistryWhatTheCloseDidNotReach_AndNeverThrows()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);
        var reached = answer.GetProperty("sessionId").GetGuid();
        var userId = await OwnerIdAsyncFromToken(app);
        var registry = app.App.Services.GetRequiredService<PcRtcSessions>();
        var unreachable = registry.Open(userId, Guid.NewGuid(), "pc-fora-do-ar");

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var listener = scope.ServiceProvider.GetServices<IUserAccessListener>().OfType<PcRtcAccessListener>().Single();
            var act = () => listener.ChangedAsync(new UserAccessChange(userId, UserAccessChangeKind.AccountDisabled), Ct);
            await act.Should().NotThrowAsync();
        }

        await ExpectRevokedCloseAsync(agent, reached);
        registry.Get(reached, userId, negotiating: false).Should().BeNull("o aviso saiu: sai do registro");
        registry.Get(unreachable.Id, userId, negotiating: false).Should().NotBeNull("o aviso não o alcançou: a sessão fica");
        await using var db = app.App.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "pc_direct_closed", Ct)).Should().Be(1, "só a que foi avisada entra na trilha");
    }

    private sealed class AccessProbe : IUserAccessListener
    {
        private int _calls;

        public string Connection { get; set; } = string.Empty;

        public int Calls => Volatile.Read(ref _calls);

        public bool? FamilyLockFree { get; private set; }

        public long? ActiveTokensOfFamily { get; private set; }

        public async Task ChangedAsync(UserAccessChange change, CancellationToken cancellationToken = default)
        {
            if (change.Kind != UserAccessChangeKind.SessionEnded || change.SessionId is not { } family)
            {
                return;
            }

            // Uma conexão nova, como a de qualquer outra requisição: só vê o que já foi gravado, e a trava da família só está livre
            // se a transação que revogou já acabou.
            await using var connection = new Npgsql.NpgsqlConnection(Connection);
            await connection.OpenAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            await using var command = new Npgsql.NpgsqlCommand(
                "SELECT pg_try_advisory_xact_lock(hashtextextended(@key, 0)), "
                + "(SELECT count(*) FROM identity.refresh_tokens WHERE family_id = @family AND revoked_at IS NULL)",
                connection,
                transaction);
            command.Parameters.AddWithValue("key", family.ToString("N"));
            command.Parameters.AddWithValue("family", family);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            await reader.ReadAsync(cancellationToken);
            FamilyLockFree = reader.GetBoolean(0);
            ActiveTokensOfFamily = reader.GetInt64(1);
            Interlocked.Increment(ref _calls);
        }
    }

    [Fact]
    public async Task AReusedRefreshToken_ClosesTheChannel_OnlyAfterTheCommit_AndOutsideTheFamilyLock()
    {
        var probe = new AccessProbe();
        await using var app = await TransportApp.StartAsync(
            postgres, new DevicesAppOptions { ConfigureServices = services => services.AddSingleton<IUserAccessListener>(probe) });
        probe.Connection = app.App.Database.OwnerConnection;
        await using var agent = await ConnectDirectAsync(app);
        var (answer, _) = await OpenAsync(app, agent);

        // Rotaciona uma vez e reapresenta o token antigo depois da folga de reuso: a família inteira cai.
        using var rotated = await app.App.RefreshRawAsync(app.Login.RefreshSecret);
        rotated.StatusCode.Should().Be(HttpStatusCode.OK);
        app.App.Time.Advance(TimeSpan.FromSeconds(4));
        using var replay = await app.App.RefreshRawAsync(app.Login.RefreshSecret);
        replay.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        await ExpectRevokedCloseAsync(agent, answer.GetProperty("sessionId").GetGuid());
        probe.Calls.Should().Be(1);
        probe.FamilyLockFree.Should().BeTrue("o aviso corre depois do commit, sem a trava da família");
        probe.ActiveTokensOfFamily.Should().Be(0, "a revogação já estava gravada quando o aviso saiu");
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
