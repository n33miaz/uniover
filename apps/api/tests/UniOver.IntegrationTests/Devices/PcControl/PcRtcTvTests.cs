using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Tv;
using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Devices.Features.PcControl;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Tvs;
using UniOver.SharedKernel;

namespace UniOver.IntegrationTests.Devices.PcControl;

/// <summary>
/// As teclas e o texto da TV pelo canal direto: a oferta leva ESCOPOS (<c>pc</c>, <c>tv</c>) que a API confere no instante dela (a
/// permissão e a TV da pessoa), o canal de um convidado nunca derruba o de quem usa o PC, e perder a permissão ou a TV fecha o escopo
/// (ou reabre o canal só com o que sobrou).
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class PcRtcTvTests(PostgresFixture postgres)
{
    private const string Control = "pc.control.v1";
    private const string Rtc = "pc.rtc.v1";
    private const string TvRtc = "tv.rtc.v1";
    private const string FakeSdp =
        "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\n";

    private static readonly string[] GuestWithTheTv = ["module:tv", "tv:control"];

    private static readonly string[] PcAndTv = ["pc", "tv"];

    private static readonly string[] TvOnly = ["tv"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<FakeAgent> ConnectAsync(TransportApp app, params string[] capabilities)
    {
        var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("0.1.0+3f2a9c1d4e5b", capabilities);
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.AgentVersion is not null, "hello processado");
        return agent;
    }

    private static Task<FakeAgent> ConnectWithTvAsync(TransportApp app) =>
        ConnectAsync(app, "transport.keepalive.v1", Control, Rtc, TvRtc);

    private static Task<HttpResponseMessage> PostAsync(TransportApp app, string path, object? body, string? token = null) =>
        app.App.SendAsync(HttpMethod.Post, $"/api/v1/pc/rtc/{path}", body, token ?? app.Login.AccessToken);

    private static Guid OwnerIdOf(TransportApp app) =>
        Guid.Parse(new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().ReadJsonWebToken(app.Login.AccessToken).Subject);

    /// <summary>
    /// Uma TV do agente da casa, com os membros dados (o dono vê todas; o convidado, só as dele). Não é a padrão: a padrão aparece
    /// também para quem nunca teve filiação (o contrato antigo), e aqui a filiação é o que se quer provar.
    /// </summary>
    private static async Task<Guid> SeedTvAsync(TransportApp app, params Guid[] members)
    {
        await using var tvs = TvApp.CreateContext(app.App.Database.OwnerConnection);
        var now = app.App.Time.GetUtcNow();

        // A aprovação do pareamento já criou a TV deste computador (a padrão, só do dono); ela dá lugar à do cenário.
        await tvs.Tvs.Where(paired => paired.AgentSlug == app.Agent.Slug).ExecuteDeleteAsync(Ct);
        var tv = ConfiguredTv.Create("TV da sala", app.Agent.Slug, isDefault: false, OwnerIdOf(app), now);
        tvs.Tvs.Add(tv);
        foreach (var member in members)
        {
            tvs.TvMembers.Add(TvMember.Create(tv.Id, member, now));
        }

        await tvs.SaveChangesAsync(Ct);
        return tv.Id;
    }

    private static async Task<JsonElement> AnswerOfferAsync(FakeAgent agent)
    {
        var command = (await agent.ReceiveAsync())!.Value;
        var body = command.GetProperty("body");
        await agent.SendTextAsync(agent.Envelope(
            "pc.rtc.answer.v1",
            new JsonObject { ["sessionId"] = body.GetProperty("sessionId").GetGuid(), ["sdp"] = "ANSWER-SDP" },
            command.GetProperty("id").GetGuid()));
        await agent.SendTextAsync(agent.Envelope(
            "command.result.v1", new JsonObject { ["ok"] = true }, command.GetProperty("id").GetGuid()));
        return command;
    }

    private static async Task<(HttpResponseMessage Response, JsonElement Offer)> OfferAsync(
        TransportApp app, FakeAgent agent, object request, string? token = null)
    {
        var posting = PostAsync(app, "offer", request, token);
        var offer = await AnswerOfferAsync(agent);
        return (await posting.WaitAsync(FakeAgent.Patience, Ct), offer);
    }

    private static async Task ExpectCloseAsync(FakeAgent agent, Guid sessionId, string reason)
    {
        var told = (await agent.ReceiveAsync())!.Value;
        told.GetProperty("type").GetString().Should().Be("pc.rtc.close.v1");
        told.GetProperty("body").GetProperty("sessionId").GetGuid().Should().Be(sessionId);
        told.GetProperty("body").GetProperty("reason").GetString().Should().Be(reason);
    }

    // ---- o que o canal leva ----

    [Fact]
    public async Task TheOwnersOffer_WithBothScopes_CarriesThemToTheAgent_AndTheAnswerSaysWhatWasGranted()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var tvId = await SeedTvAsync(app);

        var (response, offer) = await OfferAsync(app, agent, new { sdp = FakeSdp, scopes = PcAndTv, tvId });

        using (response)
        {
            response.StatusCode.Should().Be(HttpStatusCode.OK);
            (await DevicesApp.JsonAsync(response)).GetProperty("scopes").EnumerateArray().Select(s => s.GetString())
                .Should().Equal("pc", "tv");
        }

        offer.GetProperty("body").GetProperty("scopes").EnumerateArray().Select(s => s.GetString()).Should().Equal("pc", "tv");
    }

    [Fact]
    public async Task AnOfferWithoutScopes_IsThePcOnlyOfferOfAlways_WithNoScopesFieldForTheAgent()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);

        var (response, offer) = await OfferAsync(app, agent, new { sdp = FakeSdp });

        using (response)
        {
            response.StatusCode.Should().Be(HttpStatusCode.OK);
            (await DevicesApp.JsonAsync(response)).GetProperty("scopes").EnumerateArray().Select(s => s.GetString()).Should().Equal("pc");
        }

        offer.GetProperty("body").TryGetProperty("scopes", out _).Should().BeFalse("o esquema de um agente anterior é fechado");
    }

    [Fact]
    public async Task AnAgentWithoutTheTvCapability_NeverGetsTheTvScope()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectAsync(app, "transport.keepalive.v1", Control, Rtc);
        var tvId = await SeedTvAsync(app);

        // Pc + tv: o canal abre só com o PC, sem o campo que o agente anterior recusaria.
        var (both, offer) = await OfferAsync(app, agent, new { sdp = FakeSdp, scopes = PcAndTv, tvId });
        using (both)
        {
            both.StatusCode.Should().Be(HttpStatusCode.OK);
            (await DevicesApp.JsonAsync(both)).GetProperty("scopes").EnumerateArray().Select(s => s.GetString()).Should().Equal("pc");
        }

        offer.GetProperty("body").TryGetProperty("scopes", out _).Should().BeFalse();

        // Só a TV: nada a abrir, e nada é enviado ao agente.
        using var tvOnly = await PostAsync(app, "offer", new { sdp = FakeSdp, scopes = TvOnly, tvId });
        tvOnly.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(tvOnly)).GetProperty("type").GetString().Should().EndWith("/pc-direct-unavailable");
    }

    [Fact]
    public async Task AGuestWithTheTvControl_GetsATvOnlyChannel_WithoutTheDeviceFieldsOfThePc()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var guest = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", GuestWithTheTv);
        var tvId = await SeedTvAsync(app, guest.UserId);

        var (response, offer) = await OfferAsync(
            app, agent, new { sdp = FakeSdp, scopes = TvOnly, tvId }, guest.Login.AccessToken);

        using (response)
        {
            response.StatusCode.Should().Be(HttpStatusCode.OK);
            (await DevicesApp.JsonAsync(response)).GetProperty("scopes").EnumerateArray().Select(s => s.GetString()).Should().Equal("tv");
        }

        offer.GetProperty("body").GetProperty("scopes").EnumerateArray().Select(s => s.GetString()).Should().Equal("tv");
        offer.TryGetProperty("deviceId", out _).Should().BeFalse("o canal só da TV não depende da aprovação do aparelho no PC");
    }

    [Fact]
    public async Task AGuestWithoutTheTvControl_OrWithoutTheTv_GetsNothing_AndTheAgentIsNotTouched()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var viewOnly = await GuestSeed.CreateGuestAsync(
            app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Visita", ["module:tv"]);
        var notAMember = await GuestSeed.CreateGuestAsync(
            app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", GuestWithTheTv);
        var tvId = await SeedTvAsync(app, viewOnly.UserId);

        using var noControl = await PostAsync(app, "offer", new { sdp = FakeSdp, scopes = TvOnly, tvId }, viewOnly.Login.AccessToken);
        using var otherTv = await PostAsync(app, "offer", new { sdp = FakeSdp, scopes = TvOnly, tvId }, notAMember.Login.AccessToken);

        noControl.StatusCode.Should().Be(HttpStatusCode.Forbidden, "sem tv:control nem a rota abre");
        otherTv.StatusCode.Should().Be(HttpStatusCode.Forbidden, "a TV não é das dela");
        (await DevicesApp.JsonAsync(otherTv)).GetProperty("type").GetString().Should().EndWith("/pc-direct-forbidden");
    }

    // ---- um convidado nunca derruba o canal de quem usa o PC ----

    [Fact]
    public async Task AGuest_CannotTakeTheChannelOfTheOwner_AndTheOwnerTakesTheChannelOfAGuest()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var guest = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", GuestWithTheTv);
        var tvId = await SeedTvAsync(app, guest.UserId);

        // O dono usa o PC: o convidado, que só quer a TV, recebe "ocupado" e segue pela nuvem (nada vai ao agente).
        var (ownerOffer, _) = await OfferAsync(app, agent, new { sdp = FakeSdp });
        using (ownerOffer)
        {
            ownerOffer.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var busy = await PostAsync(app, "offer", new { sdp = FakeSdp, scopes = TvOnly, tvId }, guest.Login.AccessToken);
        busy.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await DevicesApp.JsonAsync(busy)).GetProperty("type").GetString().Should().EndWith("/pc-direct-busy");

        // O dono fecha o dele; o convidado agora abre o canal da TV; e o dono, voltando ao PC, o toma (o convidado cai para a nuvem).
        var sessions = app.App.Services.GetRequiredService<PcRtcSessions>();
        var ownerSession = sessions.ForAgent(app.Agent.Slug).Single();
        using (var closed = await PostAsync(app, $"{ownerSession.Id}/close", null))
        {
            closed.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        (await agent.ReceiveAsync())!.Value.GetProperty("body").GetProperty("reason").GetString().Should().Be("requested");
        var (guestOffer, _) = await OfferAsync(app, agent, new { sdp = FakeSdp, scopes = TvOnly, tvId }, guest.Login.AccessToken);
        using (guestOffer)
        {
            guestOffer.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var guestSession = sessions.ForAgent(app.Agent.Slug).Single();
        var posting = PostAsync(app, "offer", new { sdp = FakeSdp });
        await AnswerOfferAsync(agent);
        await ExpectCloseAsync(agent, guestSession.Id, "replaced");
        using var taken = await posting.WaitAsync(FakeAgent.Patience, Ct);
        taken.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ---- perder o acesso fecha ou rebaixa ----

    [Fact]
    public async Task RemovingTheGuestFromTheTv_ClosesItsTvOnlyChannel_AsRevoked_AndOnlyItsOwn()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var guest = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", GuestWithTheTv);
        var tvId = await SeedTvAsync(app, guest.UserId);
        var (opened, _) = await OfferAsync(app, agent, new { sdp = FakeSdp, scopes = TvOnly, tvId }, guest.Login.AccessToken);
        Guid sessionId;
        using (opened)
        {
            sessionId = (await DevicesApp.JsonAsync(opened)).GetProperty("sessionId").GetGuid();
        }

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var handler = scope.ServiceProvider.GetRequiredService<IIntegrationEventHandler<TvDirectAccessRemoved>>();
            // Outra pessoa: nada acontece. A entrega é "pelo menos uma vez": repetir o mesmo evento não fecha de novo.
            await handler.HandleAsync(new TvDirectAccessRemoved(IdGenerator.NewId(), DateTimeOffset.UtcNow, app.Agent.Slug, [Guid.NewGuid()]), Ct);
            var removed = new TvDirectAccessRemoved(IdGenerator.NewId(), DateTimeOffset.UtcNow, app.Agent.Slug, [guest.UserId]);
            await handler.HandleAsync(removed, Ct);
            await handler.HandleAsync(removed, Ct);
        }

        await ExpectCloseAsync(agent, sessionId, "revoked");
    }

    [Fact]
    public async Task LosingTheTvControl_OfAChannelWithBothScopes_ReopensItWithWhatRemained_NotRevoked()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var tvId = await SeedTvAsync(app);
        var (opened, _) = await OfferAsync(app, agent, new { sdp = FakeSdp, scopes = PcAndTv, tvId });
        Guid sessionId;
        using (opened)
        {
            sessionId = (await DevicesApp.JsonAsync(opened)).GetProperty("sessionId").GetGuid();
        }

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var listener = scope.ServiceProvider.GetServices<IUserAccessListener>().OfType<PcRtcAccessListener>().Single();
            await listener.ChangedAsync(new UserAccessChange(OwnerIdOf(app), UserAccessChangeKind.PermissionRemoved, Permission: "tv:control"), Ct);
        }

        await ExpectCloseAsync(agent, sessionId, "rescoped");
    }

    [Fact]
    public async Task LosingTheModulePc_DoesNotCloseATvOnlyChannel()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var tvId = await SeedTvAsync(app);
        var (opened, _) = await OfferAsync(app, agent, new { sdp = FakeSdp, scopes = TvOnly, tvId });
        Guid sessionId;
        using (opened)
        {
            sessionId = (await DevicesApp.JsonAsync(opened)).GetProperty("sessionId").GetGuid();
        }

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var listener = scope.ServiceProvider.GetServices<IUserAccessListener>().OfType<PcRtcAccessListener>().Single();
            await listener.ChangedAsync(new UserAccessChange(OwnerIdOf(app), UserAccessChangeKind.ModuleRemoved, Module: "module:pc"), Ct);
        }

        // O próximo aviso é o fechamento pedido agora, e não um `revoked` antes dele.
        using var close = await PostAsync(app, $"{sessionId}/close", null);
        close.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await ExpectCloseAsync(agent, sessionId, "requested");
    }

    // ---- a trilha da TV ----

    [Fact]
    public async Task TheTvTrail_GetsTheOpening_AndTheSumTheAgentReportsAtTheClose_NeverAKeyPerLine()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var tvId = await SeedTvAsync(app);
        var (opened, _) = await OfferAsync(app, agent, new { sdp = FakeSdp, scopes = TvOnly, tvId });
        Guid sessionId;
        using (opened)
        {
            sessionId = (await DevicesApp.JsonAsync(opened)).GetProperty("sessionId").GetGuid();
        }

        await agent.SendTextAsync(agent.Envelope(
            "pc.rtc.closed.v1",
            new JsonObject { ["sessionId"] = sessionId, ["reason"] = "idle", ["tvKeys"] = 42, ["tvTexts"] = 2 }));

        await TransportApp.WaitUntilAsync(async () =>
        {
            await using var tvs = TvApp.CreateContext(app.App.Database.OwnerConnection);
            return await tvs.CommandAudit.AnyAsync(a => a.TvId == tvId && a.Detail == "via=direct count=42 reason=idle", Ct);
        }, "a soma das teclas na trilha da TV");

        await using var db = TvApp.CreateContext(app.App.Database.OwnerConnection);
        var rows = await db.CommandAudit.AsNoTracking().Where(a => a.TvId == tvId).OrderBy(a => a.OccurredAt).ToListAsync(Ct);
        rows.Select(a => (a.Command, a.Detail)).Should().Contain(("tv.key", "via=direct opened"));
        rows.Select(a => (a.Command, a.Detail)).Should().Contain(("tv.key", "via=direct count=42 reason=idle"));
        rows.Select(a => (a.Command, a.Detail)).Should().Contain(("tv.text", "via=direct count=2 reason=idle"));
        rows.Should().HaveCountLessThanOrEqualTo(3, "uma linha por abertura e por soma, nunca uma por tecla");
    }

    [Fact]
    public async Task TheSumOfAChannelTheApiClosedItself_StillReachesTheTvTrail()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var tvId = await SeedTvAsync(app);
        var (opened, _) = await OfferAsync(app, agent, new { sdp = FakeSdp, scopes = TvOnly, tvId });
        Guid sessionId;
        using (opened)
        {
            sessionId = (await DevicesApp.JsonAsync(opened)).GetProperty("sessionId").GetGuid();
        }

        using (var close = await PostAsync(app, $"{sessionId}/close", null))
        {
            close.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        await ExpectCloseAsync(agent, sessionId, "requested");
        // O agente avisa a soma depois de fechar a pedido da API: a sessão já saiu do registro, mas a API ainda sabe de quem ela era.
        await agent.SendTextAsync(agent.Envelope(
            "pc.rtc.closed.v1", new JsonObject { ["sessionId"] = sessionId, ["reason"] = "requested", ["tvKeys"] = 7, ["tvTexts"] = 0 }));

        await TransportApp.WaitUntilAsync(async () =>
        {
            await using var tvs = TvApp.CreateContext(app.App.Database.OwnerConnection);
            return await tvs.CommandAudit.AnyAsync(a => a.TvId == tvId && a.Detail == "via=direct count=7 reason=requested", Ct);
        }, "a soma da sessão fechada pela API");
    }

    [Fact]
    public async Task TakingTheGuestOffTheTv_PublishesADurableEventInTheSameTransaction_ThatNamesTheComputerAndThePerson()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await ConnectWithTvAsync(app);
        var guest = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", GuestWithTheTv);
        var tvId = await SeedTvAsync(app, guest.UserId);

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var manage = scope.ServiceProvider.GetRequiredService<ManageTvsHandler>();
            (await manage.ReplaceMembersAsync(tvId, [], Ct)).Should().NotBeNull();
        }

        await using var tvs = TvApp.CreateContext(app.App.Database.OwnerConnection);
        var rows = await tvs.Set<OutboxMessage>().AsNoTracking().Where(m => m.Type == TvDirectAccessRemoved.EventType).ToListAsync(Ct);
        rows.Should().ContainSingle("a filiação saiu e o aviso foi gravado junto, na outbox do módulo TV");
        rows[0].Payload.Should().Contain(app.Agent.Slug).And.Contain(guest.UserId.ToString());
        await using var members = TvApp.CreateContext(app.App.Database.OwnerConnection);
        (await members.TvMembers.AnyAsync(m => m.TvId == tvId && m.UserId == guest.UserId, Ct)).Should().BeFalse();
    }

    // ---- ganhar a primeira filiação tira a TV padrão: o canal dela fecha também ----

    private static async Task<Guid> SeedDefaultTvAsync(TransportApp app)
    {
        await using var tvs = TvApp.CreateContext(app.App.Database.OwnerConnection);

        // A TV que a aprovação do pareamento criou é a padrão; só pode haver uma, e a do cenário é de outro computador.
        await tvs.Tvs.Where(paired => paired.IsDefault).ExecuteDeleteAsync(Ct);
        var tv = ConfiguredTv.Create("TV padrão", "pc-padrao", isDefault: true, OwnerIdOf(app), app.App.Time.GetUtcNow());
        tvs.Tvs.Add(tv);
        await tvs.SaveChangesAsync(Ct);
        return tv.Id;
    }

    private static async Task<List<OutboxMessage>> RemovalsAsync(TransportApp app)
    {
        await using var tvs = TvApp.CreateContext(app.App.Database.OwnerConnection);
        return await tvs.Set<OutboxMessage>().AsNoTracking().Where(m => m.Type == TvDirectAccessRemoved.EventType).ToListAsync(Ct);
    }

    [Fact]
    public async Task AddingAPersonWithNoMembershipToANonDefaultTv_ClosesTheirChannelOnTheDefaultTvComputer_OnlyThen()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", GuestWithTheTv);
        var veteran = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Veterana", GuestWithTheTv);
        var defaultTvId = await SeedDefaultTvAsync(app);
        var otherTvId = await SeedTvAsync(app, veteran.UserId);

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var manage = scope.ServiceProvider.GetRequiredService<ManageTvsHandler>();
            // O veterano já tem filiação (na outra TV): nada muda para ele. O novato perde a padrão.
            (await manage.ReplaceMembersAsync(otherTvId, [veteran.UserId, guest.UserId], Ct)).Should().NotBeNull();
        }

        var rows = await RemovalsAsync(app);
        rows.Should().ContainSingle("só quem ganhou a primeira filiação perdeu a TV padrão");
        rows[0].Payload.Should().Contain("pc-padrao").And.Contain(guest.UserId.ToString()).And.NotContain(veteran.UserId.ToString());

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var manage = scope.ServiceProvider.GetRequiredService<ManageTvsHandler>();
            // Entrar na própria TV padrão não tira nada dela, e quem já tem filiação não perde nada ao entrar em outra.
            (await manage.ReplaceMembersAsync(defaultTvId, [veteran.UserId], Ct)).Should().NotBeNull();
        }

        (await RemovalsAsync(app)).Should().ContainSingle("nenhum aviso novo");
    }

    [Fact]
    public async Task PairingANonDefaultTvWithAMemberWithNoMembership_ClosesTheirChannelOnTheDefaultTvComputer()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", GuestWithTheTv);
        await SeedDefaultTvAsync(app);

        await using (var connection = new Npgsql.NpgsqlConnection(app.App.Database.OwnerConnection))
        {
            await connection.OpenAsync(Ct);
            await using var transaction = await connection.BeginTransactionAsync(Ct);
            await using var scope = app.App.Services.CreateAsyncScope();
            var registrar = scope.ServiceProvider.GetRequiredService<IPairedTvRegistrar>();
            var afterCommit = await registrar.RegisterAsync(
                new PairedTvRegistration("pc-quarto", "Quarto", "TV do quarto", OwnerIdOf(app), [guest.UserId], CanBeDefault: false),
                connection, transaction, Ct);
            await transaction.CommitAsync(Ct);
            afterCommit.Should().NotBeNull("o aviso gravado fora do contexto do escopo precisa acordar a entrega depois do commit");
            afterCommit!();
        }

        var rows = await RemovalsAsync(app);
        rows.Should().ContainSingle();
        rows[0].Payload.Should().Contain("pc-padrao").And.Contain(guest.UserId.ToString());
    }

    [Fact]
    public async Task AddingTheOwnerToANonDefaultTv_DoesNotCloseTheirChannelOnTheDefaultTv_BecauseTheyStillSeeEveryTv()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await SeedDefaultTvAsync(app);
        var otherTvId = await SeedTvAsync(app);

        await using (var scope = app.App.Services.CreateAsyncScope())
        {
            var manage = scope.ServiceProvider.GetRequiredService<ManageTvsHandler>();
            (await manage.ReplaceMembersAsync(otherTvId, [OwnerIdOf(app)], Ct)).Should().NotBeNull();
        }

        (await RemovalsAsync(app)).Should().BeEmpty("o administrador vê todas as TVs, qualquer que seja a filiação");
    }
}
