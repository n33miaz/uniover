using System.Text.Json;
using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.PcControl;

namespace UniOver.Modules.Devices.Tests.PcControl;

public sealed class PcRtcMessagesTests
{
    private static readonly AgentEnvelopeValidator Validator = new();
    private static readonly Guid Session = Guid.Parse("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e01");

    private static bool IsValidForTheContract(OutboundMessage message)
    {
        var envelope = JsonSerializer.Serialize(new
        {
            v = 1,
            id = Guid.CreateVersion7(),
            type = message.Type,
            source = "api",
            target = "agent:pc-casa",
            ts = "2026-11-08T14:00:00Z",
            correlationId = (Guid?)null,
            body = message.Body,
        });
        return Validator.Validate(System.Text.Encoding.UTF8.GetBytes(envelope)).IsSuccess;
    }

    [Fact]
    public void TheSignalingMessagesCarryTheTypeAndBodyOfTheContract_AndAreDeliveredLive()
    {
        var token = new string('a', 43);
        var all = new (OutboundMessage Message, string Type)[]
        {
            (PcMessages.RtcOffer(Session, "v=0\r\nm=application 9\r\na=fingerprint:sha-256 AA\r\n", token, 30, 600), "pc.rtc.offer.v1"),
            (PcMessages.RtcCandidate(Session, "candidate:1 1 udp 1 192.168.1.9 5000 typ host", "0", 0), "pc.rtc.candidate.v1"),
            (PcMessages.RtcCandidate(Session, "candidate:1 1 udp 1 192.168.1.9 5000 typ host", null, null), "pc.rtc.candidate.v1"),
            (PcMessages.RtcClose(Session, PcRtcCloseV1BodyReason.Requested), "pc.rtc.close.v1"),
            (PcMessages.RtcClose(Session, PcRtcCloseV1BodyReason.Replaced), "pc.rtc.close.v1"),
            (PcMessages.RtcClose(Session, PcRtcCloseV1BodyReason.Revoked), "pc.rtc.close.v1"),
        };

        foreach (var (message, type) in all)
        {
            message.Type.Should().Be(type);
            message.Delivery.Should().Be(AgentDelivery.Immediate, "uma oferta que espera e chega depois não serve a ninguém");
            IsValidForTheContract(message).Should().BeTrue($"o corpo de {type} cumpre o esquema: {message.Body.GetRawText()}");
        }
    }
}

public sealed class PcRtcValidatorTests
{
    private const string Sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA\r\n";

    [Fact]
    public void AnOfferOfADataChannelWithAFingerprintIsValid() =>
        PcRtcValidator.Offer(new PcRtcOfferRequest(Sdp)).Should().BeEmpty();

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("hello")]
    [InlineData("v=0\r\nm=audio 9 RTP/AVP 0\r\na=fingerprint:sha-256 AA\r\n")]
    [InlineData("v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n")]
    public void AnythingElseIsRefused(string? sdp) =>
        PcRtcValidator.Offer(new PcRtcOfferRequest(sdp)).Should().ContainKey("sdp");

    [Fact]
    public void AnOfferOverTheContractSizeIsRefused() =>
        PcRtcValidator.Offer(new PcRtcOfferRequest(Sdp + new string('x', PcRtcValidator.MaxSdp))).Should().ContainKey("sdp");

    [Fact]
    public void ARequestWithNoBodyIsRefused() => PcRtcValidator.Offer(null).Should().ContainKey("sdp");

    [Theory]
    [InlineData("candidate:1 1 udp 2113937151 192.168.1.9 5000 typ host", null, null, true)]
    [InlineData("candidate:1 1 udp 2113937151 192.168.1.9 5000 typ host", "0", 0, true)]
    [InlineData("", null, null, false)]
    [InlineData(null, null, null, false)]
    [InlineData("1 1 udp 1 192.168.1.9 5000 typ host", null, null, false)]
    [InlineData("candidate:1 1 udp 1 1.2.3.4 5 typ host\r\nm=audio", null, null, false)]
    [InlineData("candidate:1 1 udp 1 192.168.1.9 5000 typ host", null, 9, false)]
    [InlineData("candidate:1 1 udp 1 192.168.1.9 5000 typ host", null, -1, false)]
    [InlineData("candidate:1 1 udp 1 192.168.1.9 5000 typ host", "012345678901234567890123456789012", null, false)]
    public void ACandidateMustBeACandidateLine(string? candidate, string? mid, int? index, bool valid) =>
        PcRtcValidator.Candidate(new PcRtcCandidateRequest(candidate, mid, index)).Count.Should().Be(valid ? 0 : 1);
}

public sealed class PcRtcSessionsTests
{
    private static readonly Guid Alice = Guid.Parse("22222222-2222-7222-8222-222222222222");
    private static readonly Guid Bruno = Guid.Parse("33333333-3333-7333-8333-333333333333");

    private static (PcRtcSessions Sessions, FakeTimeProvider Time) Build()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-08T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        return (new PcRtcSessions(time), time);
    }

    [Fact]
    public void ASessionBelongsToWhoOpenedIt_NobodyElseSeesOrTakesIt()
    {
        var (sessions, _) = Build();
        var session = sessions.Open(Alice, Guid.NewGuid(), "pc-casa");

        sessions.Get(session.Id, Alice, negotiating: false).Should().Be(session);
        sessions.Get(session.Id, Bruno, negotiating: false).Should().BeNull();
        sessions.TakeOwned(session.Id, Bruno).Should().BeNull();
        sessions.TakeOwned(session.Id, Alice).Should().Be(session);
        sessions.TakeOwned(session.Id, Alice).Should().BeNull("sai uma vez só");
    }

    [Fact]
    public void TheNegotiationWindowClosesWithTheTokenLifetime_ButTheSessionStaysUntilClosed()
    {
        var (sessions, time) = Build();
        var session = sessions.Open(Alice, Guid.NewGuid(), "pc-casa");

        time.Advance(PcRtcSessions.TokenLifetime - TimeSpan.FromSeconds(1));
        sessions.Get(session.Id, Alice, negotiating: true).Should().NotBeNull();
        time.Advance(TimeSpan.FromSeconds(2));
        sessions.Get(session.Id, Alice, negotiating: true).Should().BeNull("o token venceu");
        sessions.Get(session.Id, Alice, negotiating: false).Should().NotBeNull("fechar ainda é permitido");
    }

    [Fact]
    public void TheAgentOnlyClosesItsOwnSessions()
    {
        var (sessions, _) = Build();
        var session = sessions.Open(Alice, Guid.NewGuid(), "pc-casa");

        sessions.TakeForAgent("outro-pc", session.Id).Should().BeNull();
        sessions.TakeForAgent("pc-casa", session.Id).Should().Be(session);
        sessions.TakeForAgent("pc-casa", session.Id).Should().BeNull();
    }

    [Fact]
    public void AllTheSessionsOfAPcCanBeTakenAtOnce_ForTheReplacement()
    {
        var (sessions, _) = Build();
        var one = sessions.Open(Alice, Guid.NewGuid(), "pc-casa");
        var two = sessions.Open(Alice, Guid.NewGuid(), "pc-casa");
        var other = sessions.Open(Bruno, Guid.NewGuid(), "pc-bruno");

        sessions.TakeAllForAgent("pc-casa").Should().BeEquivalentTo([one, two]);
        sessions.Get(other.Id, Bruno, negotiating: false).Should().NotBeNull();
    }

    [Fact]
    public void AForgottenSessionIsPrunedAfterTheMaxAge()
    {
        var (sessions, time) = Build();
        var old = sessions.Open(Alice, Guid.NewGuid(), "pc-casa");

        time.Advance(PcRtcSessions.MaxAge + TimeSpan.FromMinutes(1));
        sessions.Open(Alice, Guid.NewGuid(), "pc-casa");

        sessions.Get(old.Id, Alice, negotiating: false).Should().BeNull();
    }
}

public sealed class PcRtcAnswersTests
{
    [Fact]
    public async Task TheAnswerCompletesTheWaitForTheRightAgentAndSession()
    {
        var answers = new PcRtcAnswers(TimeProvider.System);
        var session = Guid.NewGuid();
        using var pending = answers.Expect("pc-casa", session);

        answers.Complete("outro-pc", session, "errado");
        answers.Complete("pc-casa", Guid.NewGuid(), "errado");
        answers.Complete("pc-casa", session, "SDP");

        (await pending.WaitAsync(TimeSpan.FromSeconds(1), TestContext.Current.CancellationToken)).Should().Be("SDP");
    }

    [Fact]
    public async Task AnAnswerThatArrivesBeforeTheAwaitIsStillDelivered()
    {
        var answers = new PcRtcAnswers(TimeProvider.System);
        var session = Guid.NewGuid();
        using var pending = answers.Expect("pc-casa", session);
        answers.Complete("pc-casa", session, "CEDO");

        (await pending.WaitAsync(TimeSpan.FromSeconds(1), TestContext.Current.CancellationToken)).Should().Be("CEDO");
    }

    [Fact]
    public async Task WithoutAnAnswerTheWaitEndsEmptyAtTheDeadline()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        var answers = new PcRtcAnswers(time);
        using var pending = answers.Expect("pc-casa", Guid.NewGuid());

        var waiting = pending.WaitAsync(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken);
        time.Advance(TimeSpan.FromSeconds(3));

        (await waiting).Should().BeNull();
    }
}

public sealed class PcRtcAccessTests
{
    private static readonly Guid Alice = Guid.Parse("22222222-2222-7222-8222-222222222222");
    private static readonly Guid Bruno = Guid.Parse("33333333-3333-7333-8333-333333333333");

    [Fact]
    public void TakeWhere_TakesOnlyThePersonsSessionsThatMatch()
    {
        var sessions = new PcRtcSessions(TimeProvider.System);
        var family = Guid.NewGuid();
        var mine = sessions.Open(Alice, Guid.NewGuid(), "pc-casa", family);
        var other = sessions.Open(Alice, Guid.NewGuid(), "pc-casa", Guid.NewGuid());
        var stranger = sessions.Open(Bruno, Guid.NewGuid(), "pc-bruno", family);

        sessions.TakeWhere(Alice, s => s.SessionFamily == family).Should().ContainSingle().Which.Should().Be(mine);

        sessions.Get(other.Id, Alice, negotiating: false).Should().NotBeNull();
        sessions.Get(stranger.Id, Bruno, negotiating: false).Should().NotBeNull("outra pessoa nunca é tocada");
    }

    [Fact]
    public void RemainingAccess_IsWhatIsLeftOfTheAccessToken_AndTheCeilingWithoutTheClaim()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-08T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var expires = time.GetUtcNow().AddMinutes(7).ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        var with = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity([new System.Security.Claims.Claim("exp", expires)]));
        var without = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity());

        PcRtcEndpoints.RemainingAccess(with, time).Should().Be(TimeSpan.FromMinutes(7));
        PcRtcEndpoints.RemainingAccess(without, time).Should().Be(PcRtcHandler.MaxLifetime);
    }

    [Fact]
    public void TheLifetimeLimitsAreOneMinuteAndFifteen()
    {
        PcRtcHandler.MinLifetime.Should().Be(TimeSpan.FromMinutes(1));
        PcRtcHandler.MaxLifetime.Should().Be(TimeSpan.FromMinutes(15));
    }
}
