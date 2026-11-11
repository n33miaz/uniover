using System.Text.Json;
using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Devices.Features.PcControl;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Devices.Tests.PcControl;

/// <summary>Os escopos do canal direto (<c>pc</c>, <c>tv</c>): o pedido, a oferta ao agente, o que cada mudança de acesso fecha e a memória da soma da TV.</summary>
public sealed class PcRtcScopesTests
{
    private const string Sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA\r\n";
    private static readonly AgentEnvelopeValidator Validator = new();
    private static readonly Guid UserId = Guid.Parse("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e11");
    private static readonly Guid TvId = Guid.Parse("0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e22");
    private static readonly string[] PcAndTv = ["pc", "tv"];
    private static readonly string[] TvOnly = ["tv"];

    private static PcRtcSession Session(PcRtcScopes scopes, Guid? family = null) =>
        new(Guid.CreateVersion7(), UserId, Guid.NewGuid(), "pc-casa", DateTimeOffset.UnixEpoch, family, false, scopes, scopes.HasFlag(PcRtcScopes.Tv) ? TvId : null);

    // ---- os nomes e o pedido ----

    [Fact]
    public void WithoutAList_TheRequestIsThePcOnlyOfAlways() =>
        PcRtcScopeNames.Parse(null).Should().Be(PcRtcScopes.Pc);

    [Theory]
    [InlineData("pc", 1)]
    [InlineData("tv", 2)]
    [InlineData("tv,pc", 3)]
    [InlineData("power", 0)]
    public void TheNamesOfTheContractMapToTheFlags(string names, int expected) =>
        ((int)PcRtcScopeNames.Parse(names.Split(','))).Should().Be(expected);

    [Theory]
    [InlineData(1, "pc")]
    [InlineData(2, "tv")]
    [InlineData(3, "pc,tv")]
    public void TheWireNamesComeInAFixedOrder(int scopes, string expected) =>
        string.Join(',', PcRtcScopeNames.ToWire((PcRtcScopes)scopes)).Should().Be(expected);

    [Theory]
    [InlineData("")]
    [InlineData("pc,pc")]
    [InlineData("pc,tv,tv")]
    [InlineData("admin")]
    [InlineData("PC")]
    public void AnInvalidListOfScopesIsRefusedAtTheEdge(string scopes) =>
        PcRtcValidator.Offer(new PcRtcOfferRequest(Sdp, scopes.Length == 0 ? [] : scopes.Split(','))).Should().ContainKey("scopes");

    [Fact]
    public void ValidScopesAndATvAreAccepted_AndAnEmptyTvIdIsNot()
    {
        PcRtcValidator.Offer(new PcRtcOfferRequest(Sdp, PcAndTv, TvId)).Should().BeEmpty();
        PcRtcValidator.Offer(new PcRtcOfferRequest(Sdp, TvOnly, Guid.Empty)).Should().ContainKey("tvId");
    }

    // ---- a oferta ao agente ----

    [Fact]
    public void TheOfferCarriesTheScopesOnlyWhenGiven_AndBothFormsFitTheContract()
    {
        var token = new string('a', 43);
        var plain = PcMessages.RtcOffer(Guid.NewGuid(), Sdp, token, 30, 600);
        var scoped = PcMessages.RtcOffer(Guid.NewGuid(), Sdp, token, 30, 600, TvOnly);
        var both = PcMessages.RtcOffer(Guid.NewGuid(), Sdp, token, 30, 600, PcAndTv);

        plain.Body.TryGetProperty("scopes", out _).Should().BeFalse("o agente anterior tem o esquema fechado");
        scoped.Body.GetProperty("scopes").EnumerateArray().Select(s => s.GetString()).Should().Equal("tv");
        both.Body.GetProperty("scopes").EnumerateArray().Select(s => s.GetString()).Should().Equal("pc", "tv");
        foreach (var message in new[] { plain, scoped, both })
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
            Validator.Validate(System.Text.Encoding.UTF8.GetBytes(envelope)).IsSuccess.Should().BeTrue(message.Body.GetRawText());
        }
    }

    [Fact]
    public void TheRescopedReasonFitsTheCloseContract()
    {
        var message = PcMessages.RtcClose(Guid.NewGuid(), PcRtcCloseV1BodyReason.Rescoped);

        message.Body.GetProperty("reason").GetString().Should().Be("rescoped");
    }

    // ---- o que cada mudança de acesso fecha ----

    // Escopos: 1 = pc, 2 = tv, 3 = os dois. Motivo: "" = nada, "revoked" ou "rescoped".
    [Theory]
    [InlineData(1, UserAccessChangeKind.ModuleRemoved, "module:pc", null, "revoked")]
    [InlineData(1, UserAccessChangeKind.ModuleRemoved, "module:tv", null, "")]
    [InlineData(1, UserAccessChangeKind.PermissionRemoved, null, "tv:control", "")]
    [InlineData(2, UserAccessChangeKind.ModuleRemoved, "module:pc", null, "")]
    [InlineData(2, UserAccessChangeKind.ModuleRemoved, "module:tv", null, "revoked")]
    [InlineData(2, UserAccessChangeKind.PermissionRemoved, null, "tv:control", "revoked")]
    [InlineData(2, UserAccessChangeKind.PermissionRemoved, null, "tv:power", "")]
    [InlineData(3, UserAccessChangeKind.ModuleRemoved, "module:pc", null, "rescoped")]
    [InlineData(3, UserAccessChangeKind.ModuleRemoved, "module:tv", null, "rescoped")]
    [InlineData(3, UserAccessChangeKind.PermissionRemoved, null, "tv:control", "rescoped")]
    [InlineData(3, UserAccessChangeKind.ModuleRemoved, "module:training", null, "")]
    public void LosingAPermissionClosesOrReopensOnlyWhatUsedIt(
        int scopes, UserAccessChangeKind kind, string? module, string? permission, string expected)
    {
        var change = new UserAccessChange(UserId, kind, Module: module, Permission: permission);

        var reason = PcRtcAccessListener.ReasonFor(change, Session((PcRtcScopes)scopes));

        (reason is null ? string.Empty : reason.Value.ToString().ToLowerInvariant()).Should().Be(expected);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void ASessionThatEndedOrADisabledAccountRevokesEveryScope(int scopes)
    {
        var family = Guid.NewGuid();
        var session = Session((PcRtcScopes)scopes, family);

        PcRtcAccessListener.ReasonFor(new UserAccessChange(UserId, UserAccessChangeKind.AccountDisabled), session).Should().Be(PcRtcCloseV1BodyReason.Revoked);
        PcRtcAccessListener.ReasonFor(new UserAccessChange(UserId, UserAccessChangeKind.SessionEnded, family), session).Should().Be(PcRtcCloseV1BodyReason.Revoked);
        PcRtcAccessListener.ReasonFor(new UserAccessChange(UserId, UserAccessChangeKind.SessionEnded, Guid.NewGuid()), session).Should().BeNull();
        PcRtcAccessListener.ReasonFor(new UserAccessChange(UserId, UserAccessChangeKind.SessionsEnded), session).Should().Be(PcRtcCloseV1BodyReason.Revoked);
        PcRtcAccessListener.ReasonFor(new UserAccessChange(UserId, UserAccessChangeKind.SessionsEnded, family), session).Should().BeNull("a sessão que fez a troca segue");
    }

    // ---- o registro ----

    [Fact]
    public void ASessionRemembersItsScopesAndTv_AndAClosedTvSessionIsRememberedForTheLateSum()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-08T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var sessions = new PcRtcSessions(time);
        var agent = Guid.NewGuid();
        var opened = sessions.Open(UserId, agent, "pc-casa", null, PcRtcScopes.Tv, TvId);
        var pcOnly = sessions.Open(UserId, agent, "pc-casa");

        opened.Scopes.Should().Be(PcRtcScopes.Tv);
        opened.TvId.Should().Be(TvId);
        pcOnly.Scopes.Should().Be(PcRtcScopes.Pc, "sem escopos é o PC, como sempre foi");
        sessions.TakeOwned(opened.Id, UserId).Should().NotBeNull();
        sessions.TakeOwned(pcOnly.Id, UserId).Should().NotBeNull();

        // A soma do agente chega depois de a API ter fechado: só a sessão da TV é lembrada, e só para o mesmo agente.
        sessions.TakeClosedTv("outro-pc", opened.Id).Should().BeNull();
        sessions.TakeClosedTv("pc-casa", pcOnly.Id).Should().BeNull();
        sessions.TakeClosedTv("pc-casa", opened.Id)!.TvId.Should().Be(TvId);
        sessions.TakeClosedTv("pc-casa", opened.Id).Should().BeNull("a soma vale uma vez só");
    }

    [Fact]
    public void TheMemoryOfAClosedTvSessionExpires()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-08T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var sessions = new PcRtcSessions(time);
        var opened = sessions.Open(UserId, Guid.NewGuid(), "pc-casa", null, PcRtcScopes.Tv, TvId);
        sessions.TakeOwned(opened.Id, UserId);

        time.Advance(PcRtcSessions.ClosedTvMemory + TimeSpan.FromSeconds(1));

        sessions.TakeClosedTv("pc-casa", opened.Id).Should().BeNull();
    }

    [Fact]
    public void AnotherPersonsChannelIsLiveOnlyWithinTheLifetimeOfAChannel_ASessionOlderThanThatIsADeadOne()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-08T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var sessions = new PcRtcSessions(time);
        var other = Guid.NewGuid();
        sessions.Open(other, Guid.NewGuid(), "pc-casa");

        sessions.HasLiveSessionOfAnother("pc-casa", UserId).Should().BeTrue();
        sessions.HasLiveSessionOfAnother("pc-casa", other).Should().BeFalse("o canal da própria pessoa é substituído, não recusado");
        sessions.HasLiveSessionOfAnother("outro-pc", UserId).Should().BeFalse();

        time.Advance(PcRtcHandler.MaxLifetime + PcRtcSessions.TokenLifetime + TimeSpan.FromSeconds(1));

        sessions.HasLiveSessionOfAnother("pc-casa", UserId).Should().BeFalse("o agente caiu sem avisar: ninguém usa mais esse canal");
    }

    [Fact]
    public async Task TwoGuestsOfferingAtTheSameTime_NeverBothGetTheChannel_AndTheOwnerTakesIt()
    {
        var sessions = new PcRtcSessions(new FakeTimeProvider(DateTimeOffset.UnixEpoch));
        var agent = Guid.NewGuid();
        for (var round = 0; round < 200; round++)
        {
            var slug = $"pc-{round}";
            using var barrier = new Barrier(2);
            PcRtcSession? First = null, Second = null;
            var token = TestContext.Current.CancellationToken;
            var one = Task.Run(() =>
            {
                barrier.SignalAndWait();
                First = sessions.TryOpen(Guid.NewGuid(), false, agent, slug, null, PcRtcScopes.Tv, TvId, out _);
            }, token);
            var two = Task.Run(() =>
            {
                barrier.SignalAndWait();
                Second = sessions.TryOpen(Guid.NewGuid(), false, agent, slug, null, PcRtcScopes.Tv, TvId, out _);
            }, token);
            await Task.WhenAll(one, two);

            ((First is null ? 0 : 1) + (Second is null ? 0 : 1)).Should().Be(1, $"na rodada {round} só uma oferta pode reservar o agente");
            sessions.ForAgent(slug).Should().ContainSingle();
        }

        // O administrador toma o canal de qualquer um; a própria pessoa o reabre sem ser recusada por si mesma.
        var holder = Guid.NewGuid();
        sessions.TryOpen(holder, false, agent, "pc-dono", null, PcRtcScopes.Tv, TvId, out _).Should().NotBeNull();
        sessions.TryOpen(holder, false, agent, "pc-dono", null, PcRtcScopes.Tv, TvId, out _).Should().NotBeNull();
        sessions.TryOpen(Guid.NewGuid(), false, agent, "pc-dono", null, PcRtcScopes.Tv, TvId, out _).Should().BeNull();
        sessions.TryOpen(Guid.NewGuid(), true, agent, "pc-dono", null, PcRtcScopes.Pc, null, out _).Should().NotBeNull();
        await Task.CompletedTask;
    }

    [Fact]
    public async Task TheOwnerAndAGuestOfferingAtTheSameTime_NeverLeaveAGhostSession_BecauseThePreviousListComesFromTheSameCriticalSection()
    {
        var token = TestContext.Current.CancellationToken;
        for (var round = 0; round < 200; round++)
        {
            var sessions = new PcRtcSessions(new FakeTimeProvider(DateTimeOffset.UnixEpoch));
            var agent = Guid.NewGuid();
            var slug = "pc-casa";
            using var barrier = new Barrier(2);
            PcRtcSession? guest = null, owner = null;
            IReadOnlyList<PcRtcSession> ownerPrevious = [];
            var one = Task.Run(() =>
            {
                barrier.SignalAndWait();
                guest = sessions.TryOpen(Guid.NewGuid(), false, agent, slug, null, PcRtcScopes.Tv, TvId, out _);
            }, token);
            var two = Task.Run(() =>
            {
                barrier.SignalAndWait();
                owner = sessions.TryOpen(Guid.NewGuid(), true, agent, slug, null, PcRtcScopes.Pc, null, out ownerPrevious);
            }, token);
            await Task.WhenAll(one, two);

            owner.Should().NotBeNull("o administrador sempre abre");
            // O que o dono vai fechar é EXATAMENTE o que estava registrado antes da abertura dele: ou nada (o convidado veio depois,
            // e então a sessão do convidado fica de pé como a mais nova), ou a sessão do convidado (que ele substitui).
            var remaining = sessions.ForAgent(slug).Select(s => s.Id).ToHashSet();
            foreach (var replaced in ownerPrevious)
            {
                remaining.Should().Contain(replaced.Id, "a lista devolvida é de sessões que existiam");
                sessions.TakeOwned(replaced.Id, replaced.UserId).Should().NotBeNull();
            }

            // Ou o convidado foi recusado (o dono abriu primeiro), ou o dono o viu e o substituiu: nunca sobra uma sessao fantasma.
            (guest is null || ownerPrevious.Any(p => p.Id == guest.Id)).Should().BeTrue($"rodada {round}");
            sessions.ForAgent(slug).Should().ContainSingle().Which.Id.Should().Be(owner!.Id);
        }
    }

    // ---- a retirada que chega atrasada não fecha o canal aberto depois dela ----

    private static TvDirectAccessRemoved Removal(DateTimeOffset at, params Guid[]? users) =>
        new(Guid.CreateVersion7(), at, "pc-casa", users);

    [Fact]
    public void ARemovalDeliveredLate_ClosesWhatOpenedBeforeAndNearIt_ButNotTheChannelOpenedWellAfter()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-08T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var sessions = new PcRtcSessions(time);
        var agent = Guid.NewGuid();
        var before = sessions.Open(UserId, agent, "pc-casa", scopes: PcRtcScopes.Tv, tvId: TvId);
        time.Advance(TimeSpan.FromMinutes(1));
        var removedAt = time.GetUtcNow();
        // Uma oferta que leu a visibilidade antiga um instante antes do commit abre o canal depois do instante do aviso: não escapa.
        time.Advance(TimeSpan.FromSeconds(5));
        var race = sessions.Open(UserId, agent, "pc-casa", scopes: PcRtcScopes.Tv, tvId: TvId);
        time.Advance(TvDirectAccessRemovedHandler.ReopenGrace);
        var after = sessions.Open(UserId, agent, "pc-casa", scopes: PcRtcScopes.Tv, tvId: TvId);

        var plan = TvDirectAccessRemovedHandler.PlanFor(sessions, Removal(removedAt, UserId));

        plan.Select(p => p.Session.Id).Should().BeEquivalentTo([before.Id, race.Id]);
        plan.Select(p => p.Session.Id).Should().NotContain(after.Id);
    }

    [Fact]
    public void TheGraceEdgeStillCloses_WithoutAnInstantEverythingCloses_AndTheCutAlsoAppliesToEveryone()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-08T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var sessions = new PcRtcSessions(time);
        var session = sessions.Open(UserId, Guid.NewGuid(), "pc-casa", scopes: PcRtcScopes.Tv, tvId: TvId);

        TvDirectAccessRemovedHandler.PlanFor(sessions, Removal(time.GetUtcNow(), UserId)).Should().ContainSingle()
            .Which.Reason.Should().Be(PcRtcCloseV1BodyReason.Revoked);
        // Exatamente na borda da folga ainda fecha.
        TvDirectAccessRemovedHandler.PlanFor(sessions, Removal(time.GetUtcNow() - TvDirectAccessRemovedHandler.ReopenGrace, UserId)).Should().ContainSingle();
        // Aviso gravado antes de o instante existir (valor padrão): fecha como sempre fechou, sem comparar com a abertura.
        TvDirectAccessRemovedHandler.PlanFor(sessions, Removal(default, UserId)).Should().ContainSingle().Which.Session.Id.Should().Be(session.Id);
        // Para todo mundo (TV apagada ou computador trocado): o mesmo corte vale, e um aviso bem mais antigo poupa o canal novo.
        TvDirectAccessRemovedHandler.PlanFor(
            sessions, Removal(time.GetUtcNow() - TvDirectAccessRemovedHandler.ReopenGrace - TimeSpan.FromSeconds(1), null!)).Should().BeEmpty();
    }
}
