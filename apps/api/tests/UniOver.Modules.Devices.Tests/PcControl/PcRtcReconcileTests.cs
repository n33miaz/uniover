using System.Text.Json;
using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.PcControl;
using UniOver.Modules.Identity.Contracts;

namespace UniOver.Modules.Devices.Tests.PcControl;

/// <summary>
/// Reconciliar o canal direto depois de a API reiniciar: o bilhete que a API assinou na oferta é a única prova aceita; o registro reconstrói
/// a sessão sem ressuscitar o que a API fechou nem derrubar o que está em uso, e a oferta só leva o bilhete a quem sabe devolvê-lo.
/// </summary>
public sealed class PcRtcReconcileTests
{
    private static readonly AgentEnvelopeValidator Validator = new();
    private static readonly Guid Alice = Guid.Parse("22222222-2222-7222-8222-222222222222");
    private static readonly Guid Bruno = Guid.Parse("33333333-3333-7333-8333-333333333333");
    private static readonly Guid Family = Guid.Parse("44444444-4444-7444-8444-444444444444");
    private static readonly Guid Tv = Guid.Parse("55555555-5555-7555-8555-555555555555");
    private static readonly Guid Agent = Guid.Parse("66666666-6666-7666-8666-666666666666");
    private static readonly DateTimeOffset Start = DateTimeOffset.Parse("2026-11-11T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

    private static (PcRtcSessions Sessions, FakeTimeProvider Time) Build()
    {
        var time = new FakeTimeProvider(Start);
        return (new PcRtcSessions(time), time);
    }

    private static PcRtcSession Claimed(Guid? id = null, Guid? user = null, string agent = "pc-casa", PcRtcScopes scopes = PcRtcScopes.Pc) =>
        new(id ?? Guid.CreateVersion7(), user ?? Alice, Agent, agent, Start, Family, false, scopes, scopes.HasFlag(PcRtcScopes.Tv) ? Tv : null);

    // ---- o registro ----

    [Fact]
    public void ASessionTheRegistryDoesNotKnow_IsRebuiltWithTheSameId_AndFoundByWhoOwnsIt()
    {
        var (sessions, _) = Build();
        var claimed = Claimed(scopes: PcRtcScopes.Pc | PcRtcScopes.Tv);

        var restored = sessions.Restore(claimed);

        restored.Outcome.Should().Be(PcRtcRestoreOutcome.Restored);
        restored.Session.Should().Be(claimed);
        sessions.Get(claimed.Id, Alice, negotiating: false).Should().Be(claimed, "a revogação agora a acha");
        sessions.FindWhere(Alice, s => s.Scopes.HasFlag(PcRtcScopes.Tv)).Should().ContainSingle();
        sessions.Get(claimed.Id, Bruno, negotiating: false).Should().BeNull("segue sendo só de quem a abriu");
    }

    [Fact]
    public void ASessionTheRegistryAlreadyHas_IsKeptAsItWas()
    {
        var (sessions, _) = Build();
        var opened = sessions.Open(Alice, Agent, "pc-casa", sessionFamily: Family);

        var restored = sessions.Restore(opened with { SessionFamily = null });

        restored.Outcome.Should().Be(PcRtcRestoreOutcome.Known);
        restored.Session.Should().Be(opened, "vale o que a API registrou na oferta, não o que o agente conta");
    }

    [Fact]
    public void ASessionTheApiAlreadyClosed_IsNeverResurrected_HoweverItWasClosed()
    {
        var (sessions, _) = Build();
        var byThePerson = sessions.Open(Alice, Agent, "pc-casa");
        var byTheAgent = sessions.Open(Alice, Agent, "pc-casa");
        var replaced = sessions.Open(Alice, Agent, "pc-casa");
        sessions.TakeOwned(byThePerson.Id, Alice);
        sessions.TakeForAgent("pc-casa", byTheAgent.Id);
        sessions.TakeAllForAgent("pc-casa");

        foreach (var closed in new[] { byThePerson, byTheAgent, replaced })
        {
            sessions.Restore(closed).Outcome.Should().Be(PcRtcRestoreOutcome.Closed, "o agente que reconecta não ressuscita o que foi fechado");
        }

        sessions.ForAgent("pc-casa").Should().BeEmpty();
    }

    [Fact]
    public void TheMemoryOfAClosedSession_EndsAfterTheLongestLifeAChannelCanHave()
    {
        var (sessions, time) = Build();
        var session = sessions.Open(Alice, Agent, "pc-casa");
        sessions.TakeOwned(session.Id, Alice);

        time.Advance(PcRtcSessions.TombstoneMemory - TimeSpan.FromSeconds(1));
        sessions.Restore(session).Outcome.Should().Be(PcRtcRestoreOutcome.Closed);
        sessions.TakeOwned(session.Id, Alice).Should().BeNull();

        time.Advance(TimeSpan.FromSeconds(2));
        sessions.Restore(session).Outcome.Should().Be(PcRtcRestoreOutcome.Restored, "depois disso nem o agente poderia ainda a ter");
        PcRtcSessions.TombstoneMemory.Should().BeGreaterThan(PcRtcHandler.MaxLifetime);
    }

    [Fact]
    public void TheMemoryOfClosedSessions_IsBounded_AndForgetsTheOldestFirst()
    {
        var (sessions, time) = Build();
        var first = sessions.Open(Alice, Agent, "pc-casa");
        sessions.TakeOwned(first.Id, Alice);
        for (var i = 0; i < PcRtcSessions.MaxTombstones; i++)
        {
            time.Advance(TimeSpan.FromMilliseconds(1));
            var next = sessions.Open(Alice, Agent, "pc-casa");
            sessions.TakeOwned(next.Id, Alice);
        }

        sessions.Restore(first).Outcome.Should().Be(PcRtcRestoreOutcome.Restored, "a mais antiga saiu para caber a mais nova");
    }

    [Fact]
    public void ASessionMarkedForRevocation_OrOfAnotherPerson_IsNotKept()
    {
        var (sessions, _) = Build();
        var pending = sessions.Open(Alice, Agent, "pc-casa");
        sessions.MarkRevokePending(pending.Id);
        sessions.Restore(pending).Outcome.Should().Be(PcRtcRestoreOutcome.Closed);

        var (other, _) = Build();
        var theirs = other.Open(Alice, Agent, "pc-casa");
        other.Restore(theirs with { UserId = Bruno }).Outcome.Should().Be(PcRtcRestoreOutcome.Closed, "o registro diz que é de outra pessoa");
        other.Restore(theirs with { AgentSlug = "outro-pc" }).Outcome.Should().Be(PcRtcRestoreOutcome.Closed);
    }

    [Fact]
    public void WhenAnotherSessionIsLiveOnThePc_TheAgentsOneLeaves_AndAnotherPcIsNotAffected()
    {
        var (sessions, _) = Build();
        var live = sessions.Open(Bruno, Agent, "pc-casa");

        var restored = sessions.Restore(Claimed());

        restored.Outcome.Should().Be(PcRtcRestoreOutcome.Replaced, "o agente só tem um canal: a oferta em curso vale mais");
        restored.Session.Should().BeNull();
        sessions.Get(live.Id, Bruno, negotiating: false).Should().Be(live);
        sessions.Restore(Claimed(agent: "pc-do-bruno")).Outcome.Should().Be(PcRtcRestoreOutcome.Restored);
    }

    [Fact]
    public void ARevocationPendingMark_OnlyTouchesTheSessionOfTheAgentItNames()
    {
        var (sessions, _) = Build();
        var ofAnotherPc = sessions.Open(Bruno, Agent, "pc-do-bruno");
        var own = sessions.Open(Alice, Agent, "pc-casa");

        // Um id alheio citado por um bilhete inválido da conexão de "pc-casa": a sessão do outro PC não é marcada.
        sessions.MarkRevokePending(ofAnotherPc.Id, "pc-casa");
        sessions.MarkRevokePending(own.Id, "pc-casa");

        sessions.RevokePendingForAgent("pc-do-bruno").Should().BeEmpty();
        sessions.RevokePendingForAgent("pc-casa").Should().ContainSingle().Which.Id.Should().Be(own.Id);
    }

    [Fact]
    public void ATicketWithAnImpossibleInstant_IsRefusedWithoutFailing()
    {
        var tickets = Tickets();
        var good = tickets.Issue(Claims());
        var payload = System.Text.Encoding.UTF8.GetBytes(
            $$"""{"v":1,"sid":"{{Guid.NewGuid()}}","uid":"{{Alice}}","sc":1,"ag":"pc-casa","iat":0,"exp":99999999999999999}""");
        var keyed = System.Security.Cryptography.HKDF.DeriveKey(
            System.Security.Cryptography.HashAlgorithmName.SHA256, Convert.FromBase64String(KeyOf(1)), 32, null, System.Text.Encoding.UTF8.GetBytes("uniover/pc-rtc-ticket/v1"));
        var forged = Microsoft.IdentityModel.Tokens.Base64UrlEncoder.Encode(payload) + "."
            + Microsoft.IdentityModel.Tokens.Base64UrlEncoder.Encode(System.Security.Cryptography.HMACSHA256.HashData(keyed, payload));

        tickets.Read(forged, Start).Should().BeNull("a assinatura confere, mas o instante é impossível");
        tickets.Read(good, Start).Should().NotBeNull();
    }

    // ---- o que fazer com cada escopo ----

    [Theory]
    [InlineData(1, 1, null)]
    [InlineData(2, 2, null)]
    [InlineData(3, 3, null)]
    [InlineData(1, 0, "revoked")]
    [InlineData(2, 0, "revoked")]
    [InlineData(3, 0, "revoked")]
    [InlineData(3, 1, "rescoped")]
    [InlineData(3, 2, "rescoped")]
    [InlineData(1, 2, "revoked")]
    public void AChannelThatLostAScopeIsRescoped_AndOneThatLostEverythingIsRevoked(int scopes, int valid, string? expected)
    {
        var reason = PcRtcReconciler.CloseReasonFor((PcRtcScopes)scopes, (PcRtcScopes)valid);

        (reason is null ? null : reason.Value.ToString().ToLowerInvariant()).Should().Be(expected);
    }

    // ---- as mensagens ----

    private static bool IsValidForTheContract(OutboundMessage message)
    {
        var envelope = JsonSerializer.Serialize(new
        {
            v = 1,
            id = Guid.CreateVersion7(),
            type = message.Type,
            source = "api",
            target = "agent:pc-casa",
            ts = "2026-11-11T12:00:00Z",
            correlationId = (Guid?)null,
            body = message.Body,
        });
        return Validator.Validate(System.Text.Encoding.UTF8.GetBytes(envelope)).IsSuccess;
    }

    [Fact]
    public void TheOfferCarriesTheTicketOnlyWhenGiven_AndBothFormsFitTheContract()
    {
        var token = new string('a', 43);
        var ticket = Tickets().Issue(Claims());
        var plain = PcMessages.RtcOffer(Guid.NewGuid(), "sdp", token, 30, 600);
        var ticketed = PcMessages.RtcOffer(Guid.NewGuid(), "sdp", token, 30, 600, ["pc", "tv"], ticket);

        plain.Body.TryGetProperty("ticket", out _).Should().BeFalse("o esquema da oferta de um agente anterior é fechado");
        ticketed.Body.GetProperty("ticket").GetString().Should().Be(ticket);
        foreach (var message in new[] { plain, ticketed })
        {
            IsValidForTheContract(message).Should().BeTrue(message.Body.GetRawText());
        }
    }

    [Fact]
    public void TheConfirmationFitsTheContract_AndIsDeliveredLive()
    {
        var id = Guid.CreateVersion7();

        var message = PcMessages.RtcReconciled(id);

        message.Type.Should().Be("pc.rtc.reconciled.v1");
        message.Body.GetProperty("sessionIds").EnumerateArray().Select(i => i.GetGuid()).Should().Equal(id);
        message.Delivery.Should().Be(AgentDelivery.Immediate, "sem sessão viva agora, falha em vez de esperar a reconexão");
        IsValidForTheContract(message).Should().BeTrue();
    }

    [Fact]
    public void TheClaimOfTheAgentIsOnlyTheIdAndTheTicket()
    {
        var id = Guid.CreateVersion7();
        using var json = JsonDocument.Parse($$"""{"sessionId":"{{id}}","ticket":"abc.def"}""");

        var claim = PcAgentMessageHandler.ClaimOf(json.RootElement);

        claim.Should().Be(new PcRtcClaim(id, "abc.def"));
    }

    [Fact]
    public void TheNewTypesHaveADirection_TheAgentSendsTheClaim_AndTheApiSendsTheConfirmation()
    {
        AgentMessageDirections.FromAgent.Should().Contain(AgentMessageTypes.PcRtcReconcileV1);
        AgentMessageDirections.ToAgent.Should().Contain(AgentMessageTypes.PcRtcReconciledV1);
        AgentMessageDirections.ToAgent.Should().NotContain(AgentMessageTypes.PcRtcReconcileV1);
        AgentMessageDirections.FromAgent.Should().NotContain(AgentMessageTypes.PcRtcReconciledV1);
        new PcAgentMessageHandler(null!, null!, null!, null!, null!).HandledTypes.Should().Contain(AgentMessageTypes.PcRtcReconcileV1);
    }

    // ---- o bilhete assinado ----

    private static string KeyOf(byte seed) => Convert.ToBase64String(Enumerable.Range(0, 32).Select(i => (byte)(seed + i)).ToArray());

    private static PcRtcTickets Tickets(string? signing = null, string? previous = null) =>
        new(JwtKeySet.Create(
            new JwtKeyOptions { SigningKey = signing ?? KeyOf(1), PreviousSigningKey = previous },
            Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance));

    private static PcRtcTicketClaims Claims(Guid? session = null, string agent = "pc-casa", TimeSpan? lifetime = null) =>
        new(session ?? Guid.CreateVersion7(), Alice, Family, "3fa9c10d7be2465a", PcRtcScopes.Pc | PcRtcScopes.Tv, Tv, agent, Start, Start + (lifetime ?? TimeSpan.FromMinutes(15)));

    [Fact]
    public void ATicketReturnsExactlyWhatTheApiPutInIt()
    {
        var claims = Claims();

        var read = Tickets().Read(Tickets().Issue(claims), Start.AddMinutes(1));

        read.Should().Be(claims);
    }

    [Fact]
    public void AnAlteredTicket_IsNeverAccepted_InTheBodyOrInTheSignature()
    {
        var tickets = Tickets();
        var ticket = tickets.Issue(Claims());
        var dot = ticket.IndexOf('.', StringComparison.Ordinal);

        // Cada posição trocada, do corpo e da assinatura, invalida o bilhete.
        for (var i = 0; i < ticket.Length; i += 7)
        {
            // O ponto e o último caractere de cada parte (que pode carregar bits sem uso do base64) ficam de fora.
            if (i == dot || i == dot - 1 || i == ticket.Length - 1)
            {
                continue;
            }

            var changed = ticket.ToCharArray();
            changed[i] = changed[i] == 'A' ? 'B' : 'A';
            tickets.Read(new string(changed), Start).Should().BeNull($"mudou a posição {i}");
        }

        // O corpo de outro bilhete com a assinatura deste (por exemplo, trocando a pessoa).
        var other = tickets.Issue(Claims() with { UserId = Bruno });
        var spliced = other[..other.IndexOf('.', StringComparison.Ordinal)] + ticket[dot..];
        tickets.Read(spliced, Start).Should().BeNull();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("sem-ponto")]
    [InlineData(".")]
    [InlineData("a.")]
    [InlineData(".b")]
    [InlineData("não-é-base64.nem-isto")]
    public void ARubbishTicketIsRefusedWithoutFailing(string? ticket) =>
        Tickets().Read(ticket, Start).Should().BeNull();

    [Fact]
    public void AnExpiredTicketIsRefused_AtTheExactEndOfTheChannelLife()
    {
        var tickets = Tickets();
        var ticket = tickets.Issue(Claims(lifetime: TimeSpan.FromMinutes(15)));

        tickets.Read(ticket, Start.AddMinutes(15).AddSeconds(-1)).Should().NotBeNull();
        tickets.Read(ticket, Start.AddMinutes(15)).Should().BeNull();
        tickets.Read(ticket, Start.AddHours(1)).Should().BeNull();
    }

    [Fact]
    public void ATicketSignedWithAnotherKeyIsRefused_AndTheKeyRotationKeepsTheOldOnesValid()
    {
        var ticket = Tickets(KeyOf(1)).Issue(Claims());

        Tickets(KeyOf(50)).Read(ticket, Start).Should().BeNull("outra chave de assinatura");
        Tickets(KeyOf(50), previous: KeyOf(1)).Read(ticket, Start).Should().NotBeNull("a chave anterior ainda valida, como a do JWT");
    }

    [Fact]
    public void TheTicketFitsTheContractPattern()
    {
        var ticket = Tickets().Issue(Claims());

        System.Text.RegularExpressions.Regex.IsMatch(ticket, "^[A-Za-z0-9_-]{16,900}\\.[A-Za-z0-9_-]{43}$").Should().BeTrue(ticket);
        ticket.Length.Should().BeLessThan(1024);
    }

    // ---- o reconciliador, com o que está fora do registro trocado por fakes ----

    private sealed class Rig
    {
        public Rig(bool declares = true, bool connected = true)
        {
            Time = new FakeTimeProvider(Start);
            Sessions = new PcRtcSessions(Time);
            Tickets = PcRtcReconcileTests.Tickets();
            Authority = new FakeAuthority(connected ? new PcTarget(Agent, "pc-casa", true, declares ? ["pc.rtc.v1", PcMessages.RtcReconcileCapability] : ["pc.rtc.v1"], Start) : null);
            Gateway = new FakeGateway();
            Closer = new FakeCloser(Sessions);
            Reconciler = new PcRtcReconciler(
                Authority, Families, Gateway, Sessions, Closer, Tickets, new PcDeviceStates(Time), Time,
                Microsoft.Extensions.Logging.Abstractions.NullLogger<PcRtcReconciler>.Instance);
        }

        public FakeTimeProvider Time { get; }

        public PcRtcSessions Sessions { get; }

        public PcRtcTickets Tickets { get; }

        public FakeAuthority Authority { get; }

        public FakeFamilies Families { get; } = new();

        public FakeGateway Gateway { get; }

        public FakeCloser Closer { get; }

        public PcRtcReconciler Reconciler { get; }

        public PcRtcClaim Claim(PcRtcTicketClaims? claims = null, Guid? sessionId = null)
        {
            var ticket = claims ?? Claims();
            return new PcRtcClaim(sessionId ?? ticket.SessionId, Tickets.Issue(ticket));
        }

        public Task RunAsync(params PcRtcClaim[] claims) => Reconciler.ReconcileAsync("pc-casa", claims, CancellationToken.None);

        public IEnumerable<Guid> Confirmed => Gateway.Sent.Where(m => m.Type == "pc.rtc.reconciled.v1").Select(m => m.Body.GetProperty("sessionIds")[0].GetGuid());
    }

    private sealed class FakeAuthority(PcTarget? agent) : IPcRtcReconcileAuthority
    {
        public PcRtcScopes? Valid { get; set; }

        /// <summary>Roda durante a conferência (depois de a sessão estar no registro): a revogação que chega no meio.</summary>
        public Action? WhileChecking { get; set; }

        public Task<PcTarget?> AgentAsync(string slug, CancellationToken cancellationToken) => Task.FromResult(agent);

        public Task<PcRtcScopes> ValidScopesAsync(Guid userId, PcRtcScopes scopes, Guid? tvId, string agentSlug, CancellationToken cancellationToken)
        {
            WhileChecking?.Invoke();
            return Task.FromResult(Valid ?? scopes);
        }
    }

    private sealed class FakeFamilies : ISessionFamilyDirectory
    {
        public bool Active { get; set; } = true;

        public Task<bool> IsActiveAsync(Guid userId, Guid familyId, CancellationToken cancellationToken = default) => Task.FromResult(Active);
    }

    private sealed class FakeGateway : IAgentGateway
    {
        public List<OutboundMessage> Sent { get; } = [];

        public Task<UniOver.SharedKernel.Result> SendAsync(string agentId, OutboundMessage message, CancellationToken cancellationToken = default)
        {
            Sent.Add(message);
            return Task.FromResult(UniOver.SharedKernel.Result.Success());
        }

        public Task<UniOver.SharedKernel.Result<AgentReply>> RequestAsync(string agentId, OutboundMessage message, TimeSpan timeout, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();
    }

    /// <summary>Faz o que o revogador faz com o registro (tira a sessão da pessoa) e guarda o plano.</summary>
    private sealed class FakeCloser(PcRtcSessions sessions) : IPcRtcCloser
    {
        public List<(Guid Id, PcRtcCloseV1BodyReason Reason)> Closed { get; } = [];

        public Task CloseAsync(IReadOnlyList<(PcRtcSession Session, PcRtcCloseV1BodyReason Reason)> plan, CancellationToken cancellationToken)
        {
            foreach (var (session, reason) in plan)
            {
                Closed.Add((session.Id, reason));
                sessions.TakeOwned(session.Id, session.UserId);
            }

            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task AValidTicket_RebuildsTheSessionFromTheTicket_AndConfirmsIt()
    {
        var rig = new Rig();
        var claim = rig.Claim();

        await rig.RunAsync(claim);

        rig.Confirmed.Should().Equal(claim.SessionId);
        rig.Closer.Closed.Should().BeEmpty();
        var session = rig.Sessions.Get(claim.SessionId, Alice, negotiating: false)!;
        (session.UserId, session.SessionFamily, session.Scopes, session.TvId, session.AgentSlug).Should()
            .Be((Alice, Family, PcRtcScopes.Pc | PcRtcScopes.Tv, Tv, "pc-casa"), "tudo vem do bilhete, nada do que o agente declara");
        session.OpenedAt.Should().Be(Start, "a abertura é a emissão do bilhete, sem relógio do agente");
    }

    [Theory]
    [InlineData("outro-pc")]
    [InlineData("pc-do-bruno")]
    public async Task ATicketOfAnotherAgent_IsRefusedAndNothingIsRebuilt(string issuedFor)
    {
        var rig = new Rig();
        var claim = rig.Claim(Claims(agent: issuedFor));

        await rig.RunAsync(claim);

        rig.Confirmed.Should().BeEmpty();
        rig.Closer.Closed.Should().Equal([(claim.SessionId, PcRtcCloseV1BodyReason.Revoked)]);
        rig.Sessions.ForAgent("pc-casa").Should().BeEmpty();
    }

    [Fact]
    public async Task ATicketOfAnotherSession_ATamperedOne_AndAnExpiredOne_AreRefused()
    {
        var rig = new Rig();
        var sessionA = Guid.CreateVersion7();
        var otherSession = rig.Claim(Claims(session: Guid.CreateVersion7()), sessionId: sessionA);
        var good = rig.Claim(Claims());
        var tampered = new PcRtcClaim(good.SessionId, good.Ticket[..^3] + (good.Ticket.EndsWith("AAA", StringComparison.Ordinal) ? "BBB" : "AAA"));
        var expired = rig.Claim(Claims(lifetime: TimeSpan.FromMinutes(1)));
        rig.Time.Advance(TimeSpan.FromMinutes(2));

        foreach (var claim in new[] { otherSession, tampered, expired })
        {
            await rig.RunAsync(claim);
        }

        rig.Confirmed.Should().BeEmpty();
        rig.Closer.Closed.Select(c => c.Reason).Should().OnlyContain(r => r == PcRtcCloseV1BodyReason.Revoked).And.HaveCount(3);
        rig.Sessions.ForAgent("pc-casa").Should().BeEmpty();
    }

    [Fact]
    public async Task ARevokedLoginSession_NeverComesBack_EvenWithAValidTicketAndThePermissions()
    {
        var rig = new Rig();
        rig.Families.Active = false;
        var claim = rig.Claim();

        await rig.RunAsync(claim);

        rig.Confirmed.Should().BeEmpty();
        rig.Closer.Closed.Should().Equal([(claim.SessionId, PcRtcCloseV1BodyReason.Revoked)]);
        rig.Sessions.ForAgent("pc-casa").Should().BeEmpty("quem fecha também tira do registro");
    }

    [Fact]
    public async Task ATicketWithoutALoginSession_IsRefused_BecauseTheFamilyCannotBeChecked()
    {
        var rig = new Rig();
        var claim = rig.Claim(Claims() with { Family = null });

        await rig.RunAsync(claim);

        rig.Confirmed.Should().BeEmpty();
        rig.Closer.Closed.Should().ContainSingle();
    }

    [Theory]
    [InlineData(1, "Rescoped")]
    [InlineData(2, "Rescoped")]
    [InlineData(0, "Revoked")]
    public async Task ALostScopeReopensTheChannelWithWhatRemained_AndLosingEverythingRevokesIt(int stillValid, string reason)
    {
        var rig = new Rig();
        rig.Authority.Valid = (PcRtcScopes)stillValid;
        var claim = rig.Claim();

        await rig.RunAsync(claim);

        rig.Confirmed.Should().BeEmpty();
        rig.Closer.Closed.Should().Equal([(claim.SessionId, Enum.Parse<PcRtcCloseV1BodyReason>(reason))]);
    }

    [Fact]
    public async Task ASessionRevokedBetweenTheCheckAndTheConfirmation_IsNotConfirmed_ButClosed()
    {
        var rig = new Rig();
        var claim = rig.Claim();
        // A revogação chega enquanto a conferência espera (a sessão já está no registro): o revogador não alcançou o agente e a marcou.
        rig.Authority.WhileChecking = () => rig.Sessions.MarkRevokePending(claim.SessionId);

        await rig.RunAsync(claim);

        rig.Confirmed.Should().BeEmpty("confirmar cancelaria o fechamento que o agente faria sozinho em 10 s");
        rig.Closer.Closed.Should().Equal([(claim.SessionId, PcRtcCloseV1BodyReason.Revoked)]);
        rig.Sessions.ForAgent("pc-casa").Should().BeEmpty();
    }

    [Fact]
    public async Task ASessionTakenOutOfTheRegistryBetweenTheCheckAndTheConfirmation_IsNotConfirmed()
    {
        var rig = new Rig();
        var claim = rig.Claim();
        rig.Authority.WhileChecking = () => rig.Sessions.TakeOwned(claim.SessionId, Alice);

        await rig.RunAsync(claim);

        rig.Confirmed.Should().BeEmpty();
    }

    [Fact]
    public async Task AConnectionThatDidNotDeclareTheCapability_IsIgnored_AndNothingIsRebuilt()
    {
        var rig = new Rig(declares: false);

        await rig.RunAsync(rig.Claim());

        rig.Confirmed.Should().BeEmpty();
        rig.Gateway.Sent.Should().BeEmpty("nem fechamento: a mensagem não devia ter vindo");
        rig.Closer.Closed.Should().BeEmpty();
        rig.Sessions.ForAgent("pc-casa").Should().BeEmpty();
    }

    [Fact]
    public async Task AnAgentThatIsNotConnected_IsIgnored()
    {
        var rig = new Rig(connected: false);

        await rig.RunAsync(rig.Claim());

        rig.Gateway.Sent.Should().BeEmpty();
        rig.Sessions.ForAgent("pc-casa").Should().BeEmpty();
    }

    [Fact]
    public async Task ASessionTheApiAlreadyClosed_IsRefusedEvenWithAValidTicket()
    {
        var rig = new Rig();
        var opened = rig.Sessions.Open(Alice, Agent, "pc-casa");
        rig.Sessions.TakeOwned(opened.Id, Alice);
        var tombstoned = rig.Claim(Claims(session: opened.Id));

        await rig.RunAsync(tombstoned);

        rig.Confirmed.Should().BeEmpty();
        rig.Closer.Closed.Should().Equal([(opened.Id, PcRtcCloseV1BodyReason.Revoked)]);
    }

    [Fact]
    public async Task AnotherLiveSessionOnThePc_WinsOverTheOneTheAgentHolds()
    {
        var rig = new Rig();
        var live = rig.Sessions.Open(Bruno, Agent, "pc-casa");
        var claim = rig.Claim();

        await rig.RunAsync(claim);

        rig.Confirmed.Should().BeEmpty();
        rig.Closer.Closed.Should().Equal([(claim.SessionId, PcRtcCloseV1BodyReason.Replaced)]);
        rig.Sessions.Get(live.Id, Bruno, negotiating: false).Should().NotBeNull();
    }
}
