using System.Text.Json;
using AwesomeAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Adapters;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.Presence;

namespace UniOver.Modules.Devices.Tests.Transport;

/// <summary>
/// A saúde do agente medida só pelo que chega da conexão, com relógio falso: um PC paginado (socket aberto, mudo) é
/// reconhecido em 1,4 batimento medido (35 s no de 25 s; o piso de 15 s no de 5 s), com ou sem uso, e a partir daí o comando falha na hora, sem sair. A TV que demora
/// (prazo estourado com o batimento em dia) é só lenta, e a soltura de botão ou tecla sempre sai.
/// </summary>
public sealed class AgentHealthTests
{
    private const string Agent = "pc-casa";
    private static readonly DateTimeOffset Start = new(2026, 11, 12, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(8);

    private static OutboundMessage Key() =>
        new("tv.key.v1", JsonSerializer.SerializeToElement(new { key = "VOLUME_UP" }));

    private sealed class Rig
    {
        public Rig(DevicesTransportOptions? settings = null, SseStreamOptions? stream = null)
        {
            Time = new FakeTimeProvider(Start);
            var options = Options.Create(settings ?? new DevicesTransportOptions());
            Events = new SseBroadcaster<PresenceUpdate>(stream ?? new SseStreamOptions());
            Listener = new CountingListener();
            Connections = new AgentConnections(new InMemoryPresenceStore(Time, options), Events, [Listener], Time, options);
            Health = new AgentHealth(Time, options, Connections);
        }

        public FakeTimeProvider Time { get; }

        public SseBroadcaster<PresenceUpdate> Events { get; }

        public CountingListener Listener { get; }

        public AgentConnections Connections { get; }

        public AgentHealth Health { get; }

        /// <summary>Conecta e faz o hello com (ou sem) o batimento: é o que liga a medição.</summary>
        public RecordingSession Connect(bool keepAlive = true)
        {
            var session = new RecordingSession(Agent);
            Connections.Attach(session, Time.GetUtcNow());
            Health.Reset(Agent);
            Connections.RecordHello(session, "1.0.0", keepAlive ? ["tv.remote", "transport.keepalive.v1"] : ["tv.remote"], Time.GetUtcNow());
            Health.Watch(Agent, keepAlive);
            return session;
        }

        /// <summary>
        /// Batimentos do agente a cada <paramref name="every"/>, na ordem do hub: o quadro conta para a saúde e depois o
        /// <c>agent.keepalive.v1</c> é guardado (com o intervalo desde o anterior).
        /// </summary>
        public void Beats(RecordingSession session, TimeSpan every, int count)
        {
            for (var i = 0; i < count; i++)
            {
                Time.Advance(every);
                Health.OnFrame(Agent);
                Connections.RecordKeepalive(session, loopLagMs: null, Time.GetUtcNow());
            }
        }

        /// <summary>Um comando enviado agora que estoura o prazo sem resposta.</summary>
        public void MissOne()
        {
            var sentAt = Time.GetUtcNow();
            Time.Advance(CommandTimeout);
            Health.OnTimeout(Agent, sentAt);
        }
    }

    private sealed class CountingListener : IAgentPresenceListener
    {
        public int Calls { get; private set; }

        public void OnPresenceChanged(AgentPresenceInfo info) => Calls++;
    }

    [Fact]
    public void Silence_MarksUnresponsiveAt35Seconds_AndAnyFrameBringsItBack()
    {
        var rig = new Rig();
        rig.Connect();

        rig.Time.Advance(TimeSpan.FromSeconds(34));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready, "um batimento de 25 s atrasado pela rede ainda não é PC parado");

        rig.Time.Advance(TimeSpan.FromSeconds(1));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Unresponsive, "1,4 batimento sem nada: o laço parou");

        rig.Health.OnFrame(Agent);
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready);
    }

    [Fact]
    public void AFiveSecondBeat_IsUnresponsiveAfterThreeMissedBeats_AtFifteenSeconds()
    {
        // O agente de agora bate a cada 5 s; a configuração segue com os 25 s do anterior. Vale o batimento medido na sessão.
        var rig = new Rig();
        var session = rig.Connect();
        rig.Beats(session, TimeSpan.FromSeconds(5), count: 3);

        rig.Time.Advance(TimeSpan.FromSeconds(14));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready, "menos de 3 batimentos perdidos: ainda pode ser a rede");

        rig.Time.Advance(TimeSpan.FromSeconds(1));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Unresponsive, "3 batimentos de 5 s perdidos (o piso de 15 s)");

        rig.Beats(session, TimeSpan.Zero, count: 1);
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready);
    }

    [Fact]
    public void ATwentyFiveSecondBeat_KeepsTheLimitsOfBefore()
    {
        var rig = new Rig();
        var session = rig.Connect();
        rig.Beats(session, TimeSpan.FromSeconds(25), count: 3);

        rig.Time.Advance(TimeSpan.FromSeconds(34));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready, "o agente anterior segue com os 35 s (1,4 batimento)");
        rig.Time.Advance(TimeSpan.FromSeconds(1));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Unresponsive);
    }

    [Fact]
    public void ATwentyFiveSecondAgent_WithOneJitteryBeat_KeepsItsThirtyFiveSeconds()
    {
        // Um batimento atrasado 22 s pela rede chega 3 s antes do seguinte: um intervalo curto só não aperta os limites.
        var rig = new Rig();
        var session = rig.Connect();
        rig.Beats(session, TimeSpan.FromSeconds(25), count: 3);
        rig.Beats(session, TimeSpan.FromSeconds(47), count: 1);
        rig.Beats(session, TimeSpan.FromSeconds(3), count: 1);
        rig.Beats(session, TimeSpan.FromSeconds(25), count: 1);

        rig.Time.Advance(TimeSpan.FromSeconds(34));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready, "o próximo batimento de 25 s ainda está no prazo");
        rig.Time.Advance(TimeSpan.FromSeconds(1));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Unresponsive);
    }

    [Fact]
    public void AFiveSecondAgent_BackFromAPause_NeverWaitsLongerThanBefore_AndTightensAgain()
    {
        // O PC paginado volta: o batimento da volta mede a pausa (40 s), que não afrouxa os limites além dos de sempre.
        var rig = new Rig();
        var session = rig.Connect();
        rig.Beats(session, TimeSpan.FromSeconds(5), count: 3);
        rig.Beats(session, TimeSpan.FromSeconds(40), count: 1);
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready);
        rig.Beats(session, TimeSpan.FromSeconds(5), count: 1);

        rig.Time.Advance(TimeSpan.FromSeconds(35));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Unresponsive, "a pausa medida nunca passa dos 35 s do batimento de 25 s");

        // Com os batimentos em dia de novo, os 15 s voltam.
        rig.Beats(session, TimeSpan.Zero, count: 1);
        rig.Beats(session, TimeSpan.FromSeconds(5), count: 3);
        rig.Time.Advance(TimeSpan.FromSeconds(14));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready);
        rig.Time.Advance(TimeSpan.FromSeconds(1));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Unresponsive);
    }

    [Theory]
    [InlineData(5, 15, 10)]
    [InlineData(25, 35, 30)]
    [InlineData(1, 15, 10)]
    public void TheLimits_ComeFromTheBeat_WithFloors(int beat, int silence, int muteAfter)
    {
        AgentHealth.SilenceFor(TimeSpan.FromSeconds(beat)).Should().Be(TimeSpan.FromSeconds(silence));
        AgentHealth.MuteAfterFor(TimeSpan.FromSeconds(beat)).Should().Be(TimeSpan.FromSeconds(muteAfter));
    }

    [Fact]
    public void KeepAlivesEvery25Seconds_KeepTheAgentReady_ForAnHour()
    {
        var rig = new Rig();
        rig.Connect();

        for (var i = 0; i < 144; i++)
        {
            rig.Time.Advance(TimeSpan.FromSeconds(25));
            rig.Health.OnFrame(Agent);
            rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready);
        }
    }

    [Fact]
    public void ATvOpeningItsSessionSlowly_WithTwoVolumeTaps_IsOnlySlow_CommandsKeepGoing()
    {
        // A sessão da TV abrindo devagar: dois toques de volume estouram o prazo de 8 s juntos, sem batimento no meio (ele é de
        // 25 s). O agente está vivo: isso é lento, não "sem resposta", e o comando seguinte não pode falhar na hora.
        var rig = new Rig();
        rig.Connect();
        rig.Time.Advance(TimeSpan.FromSeconds(2));
        var first = rig.Time.GetUtcNow();
        var second = first.AddMilliseconds(300);
        rig.Time.Advance(CommandTimeout + TimeSpan.FromMilliseconds(300));
        rig.Health.OnTimeout(Agent, first);
        rig.Health.OnTimeout(Agent, second);

        rig.Health.Of(Agent).Should().Be(AgentHealthState.Slow);

        // Mais um prazo estourado ainda dentro do intervalo do batimento: segue só lento.
        var third = rig.Time.GetUtcNow();
        rig.Time.Advance(CommandTimeout);
        rig.Health.OnTimeout(Agent, third);
        rig.Health.IsUnresponsive(Agent).Should().BeFalse();
    }

    [Fact]
    public void MuteMissesThatTimeOutTogether_CountAsOne()
    {
        // Calado há 23 s, dois comandos saem juntos e estouram aos 31 s (já depois de 1,2 batimento): é um sinal só.
        var rig = new Rig();
        rig.Connect();
        rig.Time.Advance(TimeSpan.FromSeconds(23));
        var sentAt = rig.Time.GetUtcNow();
        rig.Time.Advance(CommandTimeout);
        rig.Health.OnTimeout(Agent, sentAt);
        rig.Health.OnTimeout(Agent, sentAt);

        rig.Health.Of(Agent).Should().Be(AgentHealthState.Slow, "dois prazos que estouram juntos não são dois sinais");
    }

    [Fact]
    public void TwoMuteMissesInSequence_MarkUnresponsive_OnTheirOwn()
    {
        // Com um batimento longo (o silêncio total bem mais adiante), a regra dos prazos mudos funciona sozinha.
        var rig = new Rig(new DevicesTransportOptions { AgentKeepAliveSeconds = 300 });
        rig.Connect();
        rig.Time.Advance(TimeSpan.FromSeconds(360));
        rig.MissOne();
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Slow);

        rig.MissOne();
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Unresponsive);
    }

    [Fact]
    public void MissesWhileFramesStillArrive_AreOnlySlow_TheLoopIsAlive()
    {
        var rig = new Rig();
        rig.Connect();

        for (var i = 0; i < 4; i++)
        {
            var sentAt = rig.Time.GetUtcNow();
            rig.Time.Advance(TimeSpan.FromSeconds(4));
            rig.Health.OnFrame(Agent);
            rig.Time.Advance(TimeSpan.FromSeconds(4));
            rig.Health.OnTimeout(Agent, sentAt);
        }

        rig.Health.Of(Agent).Should().Be(AgentHealthState.Slow, "o batimento chegou depois de cada envio: lento, não mudo");
    }

    [Fact]
    public void AfterAMissAndSilence_AFrameMakesItSlow_AndAReplyInTimeMakesItReady()
    {
        var rig = new Rig();
        rig.Connect();
        rig.MissOne();
        rig.Time.Advance(TimeSpan.FromSeconds(30));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Unresponsive);

        rig.Health.OnFrame(Agent);
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Slow, "voltou a falar; ainda falta provar que responde");

        rig.Health.OnReply(Agent, TimeSpan.FromMilliseconds(300), CommandTimeout);
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready);
    }

    [Fact]
    public void AReplyAfterHalfItsTimeout_IsSlow_AndAQuickOneIsReadyAgain()
    {
        var rig = new Rig();
        rig.Connect();

        rig.Health.OnReply(Agent, TimeSpan.FromSeconds(5), CommandTimeout);
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Slow);

        rig.Health.OnReply(Agent, TimeSpan.FromSeconds(1), CommandTimeout);
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready);
    }

    [Fact]
    public void AnAgentWithoutTheKeepAlive_IsNeverMeasured()
    {
        var rig = new Rig();
        rig.Connect(keepAlive: false);

        rig.MissOne();
        rig.MissOne();
        rig.Time.Advance(TimeSpan.FromMinutes(10));

        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready, "sem batimento, nada o tiraria do mudo depois");
        rig.Health.Describe(Agent).Should().BeNull();
    }

    [Fact]
    public void ANewSession_StartsFresh_AndTheDropForgetsTheAgent()
    {
        var rig = new Rig();
        rig.Connect();
        rig.Time.Advance(TimeSpan.FromSeconds(35));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Unresponsive);

        rig.Connect();
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready, "a sessão nova não herda o mudo da anterior");

        rig.Health.Forget(Agent);
        rig.Time.Advance(TimeSpan.FromMinutes(5));
        rig.Health.Of(Agent).Should().Be(AgentHealthState.Ready);
        rig.Health.Describe(Agent).Should().BeNull();
    }

    [Fact]
    public void EachChange_GoesToTheSseInOrder_AndNeverToThePresenceListeners()
    {
        var rig = new Rig();
        rig.Connect();
        var listenerCalls = rig.Listener.Calls;
        using var stream = rig.Events.Subscribe("dono");

        rig.Time.Advance(TimeSpan.FromSeconds(35));
        rig.Health.OnFrame(Agent);
        rig.MissOne();
        rig.Health.OnReply(Agent, TimeSpan.FromMilliseconds(200), CommandTimeout);

        var seen = new List<string?>();
        while (stream.Reader.TryRead(out var message))
        {
            message.EventType.Should().Be(PresenceUpdate.ChangeEvent);
            message.Data.Agents.Should().ContainSingle();
            message.Data.Agents[0].Connected.Should().BeTrue();
            seen.Add(message.Data.Agents[0].Health);
        }

        seen.Should().Equal("unresponsive", "ready", "slow", "ready");
        rig.Listener.Calls.Should().Be(listenerCalls, "os ouvintes de presença leem o banco; a saúde não passa por eles");
    }

    [Fact]
    public async Task ConcurrentChanges_TheLastSseEventIsAlwaysTheCurrentState()
    {
        // Cada resposta alterna lenta/pronta, então quase toda chamada é um aviso: a fila do assinante precisa caber
        // todos, senão ela enche, o fluxo é fechado (o cliente reconecta e recebe o retrato) e o último lido é qualquer um.
        var rig = new Rig(stream: new SseStreamOptions { SubscriberQueue = 8 * 200 + 16 });
        rig.Connect();
        using var stream = rig.Events.Subscribe("dono");

        await Task.WhenAll(Enumerable.Range(0, 8).Select(i => Task.Run(
            () =>
            {
                for (var n = 0; n < 200; n++)
                {
                    var latency = (n + i) % 2 == 0 ? TimeSpan.FromSeconds(5) : TimeSpan.FromMilliseconds(5);
                    rig.Health.OnReply(Agent, latency, CommandTimeout);
                }
            },
            TestContext.Current.CancellationToken)));

        string? last = null;
        while (stream.Reader.TryRead(out var message))
        {
            last = message.Data.Agents[0].Health;
        }

        stream.Reader.Completion.IsCompleted.Should().BeFalse("a fila coube todos os avisos");
        last.Should().Be(AgentHealth.Text(rig.Health.Of(Agent)), "o aviso sai sob a mesma trava da mudança");
    }

    [Theory]
    [InlineData("""{"dx":3,"dy":-2}""", true)]
    [InlineData("""{"dx":3,"dy":-2,"scrollX":0,"scrollY":0}""", true)]
    [InlineData("""{"dx":0,"dy":0,"scrollY":120}""", false)]
    [InlineData("""{"dx":1,"dy":1,"scrollX":-120}""", false)]
    public void OnlyAPureMove_CanBeDropped_ScrollAlwaysGoesOut(string body, bool droppable) =>
        AgentGateway.IsPureMove(Pc("pc.pointer.v1", body)).Should().Be(droppable);

    private static OutboundMessage Pc(string type, string body) => new(type, JsonDocument.Parse(body).RootElement.Clone());

    private static (AgentGateway Gateway, AgentHealth Health, RecordingSession Session, RestartRig Rig) Wired()
    {
        var rig = new RestartRig();
        var health = new AgentHealth(rig.Time, rig.Options, rig.Connections);
        var gateway = new AgentGateway(
            rig.Connections, rig.Factory, rig.Correlator, rig.Options, rig.Time, NullLogger<AgentGateway>.Instance, health);
        var session = new RecordingSession(Agent);
        rig.Connections.Attach(session, rig.Time.GetUtcNow());
        health.Reset(Agent);
        health.Watch(Agent, declaresKeepAlive: true);
        return (gateway, health, session, rig);
    }

    [Fact]
    public async Task Gateway_ATvSlowToOpen_NeverMakesTheNextCommandFailAtOnce()
    {
        var (gateway, health, session, rig) = Wired();

        // Dois toques de volume enquanto a TV abre a sessão: os dois estouram o prazo juntos.
        var first = gateway.RequestAsync(Agent, Key(), CommandTimeout, TestContext.Current.CancellationToken);
        var second = gateway.RequestAsync(Agent, Key(), CommandTimeout, TestContext.Current.CancellationToken);
        rig.Time.Advance(CommandTimeout);
        (await first.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken)).Error.Code.Should().Be(AgentErrors.TimeoutCode);
        (await second.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken)).Error.Code.Should().Be(AgentErrors.TimeoutCode);
        health.Of(Agent).Should().Be(AgentHealthState.Slow);

        var third = gateway.RequestAsync(Agent, Key(), CommandTimeout, TestContext.Current.CancellationToken);
        session.Sent.Should().HaveCount(3, "o agente está vivo (batimento em dia): o terceiro toque sai");
        rig.Time.Advance(CommandTimeout);
        await third.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Gateway_FailsAtOnceWithoutSending_WhileTheAgentIsMute_ButAReleaseAlwaysGoesOut()
    {
        var (gateway, health, session, rig) = Wired();
        rig.Time.Advance(TimeSpan.FromSeconds(35));
        health.Of(Agent).Should().Be(AgentHealthState.Unresponsive);

        // Sem andar o relógio: a falha vem na hora, e nada sai para o agente executar quando acordar.
        var fast = gateway.RequestAsync(Agent, Key(), CommandTimeout, TestContext.Current.CancellationToken);
        fast.IsCompleted.Should().BeTrue();
        (await fast).Error.Code.Should().Be(AgentErrors.StalledCode);
        var press = gateway.RequestAsync(
            Agent, Pc("pc.click.v1", """{"button":"LEFT","action":"DOWN"}"""), CommandTimeout, TestContext.Current.CancellationToken);
        (await press).Error.Code.Should().Be(AgentErrors.StalledCode);
        session.Sent.Should().BeEmpty();

        // A soltura sempre sai: sem ela o botão (ou a tecla) ficaria preso no PC quando ele voltar.
        var releases = new[]
        {
            gateway.RequestAsync(
                Agent, Pc("pc.click.v1", """{"button":"LEFT","action":"UP"}"""), CommandTimeout, TestContext.Current.CancellationToken),
            gateway.RequestAsync(
                Agent, Pc("pc.key.v2", """{"key":"SHIFT","action":"UP"}"""), CommandTimeout, TestContext.Current.CancellationToken),
        };
        session.Sent.Should().HaveCount(2);
        for (var i = 0; i < 2; i++)
        {
            var id = JsonDocument.Parse(session.Sent[i]).RootElement.GetProperty("id").GetGuid();
            rig.Correlator.TryComplete(Agent, id, new AgentReply(id, true, null)).Should().BeTrue();
            (await releases[i].WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken)).IsSuccess.Should().BeTrue();
        }

        // Voltou a falar: o comando sai de novo e a resposta em dia o deixa pronto.
        health.OnFrame(Agent);
        var again = gateway.RequestAsync(Agent, Key(), CommandTimeout, TestContext.Current.CancellationToken);
        session.Sent.Should().HaveCount(3);
        var last = JsonDocument.Parse(session.Sent[2]).RootElement.GetProperty("id").GetGuid();
        rig.Correlator.TryComplete(Agent, last, new AgentReply(last, true, null)).Should().BeTrue();
        (await again.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken)).IsSuccess.Should().BeTrue();
        health.Of(Agent).Should().Be(AgentHealthState.Ready);
    }
}
