using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.AgentProtocol;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Adapters;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Features.GetModuleInfo;
using UniOver.Modules.Devices.Features.Presence;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Tests.Transport;

/// <summary>
/// A passagem de uma versão do agente para outra: a candidata (rota própria) só assume a conexão com o <c>hello</c> de passagem
/// válido, e a antiga sai com o motivo certo (<c>Handover</c> se ela declarou entendê-lo, <c>Replaced</c> nos demais casos).
/// </summary>
public sealed class AgentHubHandoverTests
{
    private const string Slug = "pc-casa";
    private static readonly DateTimeOffset Start = new(2026, 11, 10, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan HelloWait = TimeSpan.FromSeconds(7);

    private sealed class FixedClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; } = now;
    }

    /// <summary>Sessão roteirizada: o teste empurra quadros e vê como o núcleo a fechou.</summary>
    private sealed class ScriptedSession(bool completeOnClose = true, bool candidate = false) : IAgentSession
    {
        private readonly Channel<byte[]> _frames = Channel.CreateUnbounded<byte[]>();
        private readonly List<AgentCloseReason> _closed = [];

        public string AgentId => Slug;

        public bool IsHandoverCandidate => candidate;

        /// <summary>Os fechamentos pedidos pelo núcleo, sem o <c>Normal</c> da limpeza final da própria sessão.</summary>
        public IReadOnlyList<AgentCloseReason> Closed
        {
            get
            {
                lock (_closed)
                {
                    return [.. _closed.Where(reason => reason != AgentCloseReason.Normal)];
                }
            }
        }

        public void Push(string json) => _frames.Writer.TryWrite(Encoding.UTF8.GetBytes(json));

        public void EndOfStream() => _frames.Writer.TryComplete();

        public async ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken) =>
            await _frames.Reader.WaitToReadAsync(cancellationToken) ? await _frames.Reader.ReadAsync(cancellationToken) : null;

        /// <summary>O que o núcleo mandou a esta sessão (o JSON dos envelopes), na ordem.</summary>
        public List<string> Sent { get; } = [];

        public ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken)
        {
            lock (Sent)
            {
                Sent.Add(Encoding.UTF8.GetString(envelope.Span));
            }

            return ValueTask.FromResult(true);
        }

        public Task CloseAsync(AgentCloseReason reason, CancellationToken cancellationToken)
        {
            lock (_closed)
            {
                _closed.Add(reason);
            }

            if (completeOnClose)
            {
                _frames.Writer.TryComplete();
            }

            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class Rig
    {
        public Rig()
        {
            Time = new FakeTimeProvider(Start);
            Correlator = new ReplyCorrelator();
            var options = Options.Create(new DevicesTransportOptions { HandoverHelloWaitSeconds = (int)HelloWait.TotalSeconds });
            Presence = new InMemoryPresenceStore(Time, options);
            Connections = new AgentConnections(Presence, new SseBroadcaster<PresenceUpdate>(new SseStreamOptions()), null, Time, options);
            var scopes = new ServiceCollection().BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
            var validator = new AgentEnvelopeValidator();
            Hub = new AgentHub(
                validator,
                new OutboundEnvelopeFactory(validator, new FixedClock(Start)),
                Connections,
                new AgentPresencePersistence(scopes, NullLogger<AgentPresencePersistence>.Instance),
                Correlator,
                new InMemoryAgentLogReports(Time),
                scopes,
                options,
                Time,
                NullLogger<AgentHub>.Instance);
        }

        public FakeTimeProvider Time { get; }

        public ReplyCorrelator Correlator { get; }

        public InMemoryPresenceStore Presence { get; }

        public AgentConnections Connections { get; }

        public AgentHub Hub { get; }

        public Task Run(ScriptedSession session) => Hub.RunSessionAsync(session, CancellationToken.None);

        public bool Connected => Presence.Get(Slug)!.Connected;
    }

    private static string Envelope(string type, JsonObject body) =>
        new JsonObject
        {
            ["v"] = 1,
            ["id"] = Guid.CreateVersion7().ToString(),
            ["type"] = type,
            ["source"] = $"agent:{Slug}",
            ["target"] = "api",
            ["ts"] = "2026-11-10T12:00:00Z",
            ["correlationId"] = null,
            ["body"] = body,
        }.ToJsonString();

    private const string HandoverCapability = "agent.handover.v1";

    private static string Hello(bool? handover, params string[] capabilities)
    {
        var body = new JsonObject
        {
            ["agentVersion"] = "2.0.0",
            ["capabilities"] = new JsonArray([.. capabilities.Select(c => (JsonNode)JsonValue.Create(c)!)]),
        };
        if (handover is { } flag)
        {
            body["instanceId"] = Guid.CreateVersion7().ToString();
            body["handover"] = flag;
        }

        return Envelope("agent.hello.v1", body);
    }

    /// <summary>Hello que pede a passagem; <paramref name="instanceId"/> nulo = sem o campo.</summary>
    private static string HandoverHello(string? instanceId)
    {
        var body = new JsonObject
        {
            ["agentVersion"] = "2.0.0",
            ["capabilities"] = new JsonArray(),
            ["handover"] = true,
        };
        if (instanceId is not null)
        {
            body["instanceId"] = instanceId;
        }

        return Envelope("agent.hello.v1", body);
    }

    private static string KeepAlive() => Envelope("agent.keepalive.v1", []);

    private static async Task WaitUntil(Func<bool> condition, string what)
    {
        for (var i = 0; i < 500; i++)
        {
            if (condition())
            {
                return;
            }

            await Task.Delay(10, TestContext.Current.CancellationToken);
        }

        throw new TimeoutException($"Esperava: {what}.");
    }

    private static string CommandResult(Guid commandId) =>
        new JsonObject
        {
            ["v"] = 1,
            ["id"] = Guid.CreateVersion7().ToString(),
            ["type"] = "command.result.v1",
            ["source"] = $"agent:{Slug}",
            ["target"] = "api",
            ["ts"] = "2026-11-10T12:00:00Z",
            ["correlationId"] = commandId.ToString(),
            ["body"] = new JsonObject { ["ok"] = true },
        }.ToJsonString();

    /// <summary>Avança o relógio de mentira em passos curtos (o que espera pelo correlator confere a cada 50 ms) até <paramref name="done"/>.</summary>
    private static async Task AdvanceUntil(Rig rig, Task done)
    {
        for (var i = 0; i < 400 && !done.IsCompleted; i++)
        {
            rig.Time.Advance(TimeSpan.FromMilliseconds(50));
            await Task.Delay(5, TestContext.Current.CancellationToken);
        }
    }

    /// <summary>
    /// Conecta a antiga (já a atual) e, em seguida, abre a conexão nova (candidata ou comum); devolve as duas rodando no núcleo.
    /// A antiga declara <c>agent.handover.v1</c> no <c>hello</c> (é o que faz a API fechá-la com o 4410), salvo se <paramref name="oldKnowsHandover"/> for falso.
    /// </summary>
    private static async Task<(ScriptedSession Old, Task OldRun, ScriptedSession New, Task NewRun)> ConnectAsync(
        Rig rig, bool candidate, bool oldCompletesOnClose = true, bool oldKnowsHandover = true)
    {
        var old = new ScriptedSession(oldCompletesOnClose);
        var oldRun = rig.Run(old);
        await WaitUntil(() => rig.Connections.IsCurrent(old), "a antiga ser a atual");
        old.Push(oldKnowsHandover ? Hello(handover: null, HandoverCapability) : Hello(handover: null));
        await WaitUntil(
            () => rig.Presence.Get(Slug)!.Capabilities.Contains(HandoverCapability) == oldKnowsHandover
                && rig.Presence.Get(Slug)!.AgentVersion == "2.0.0",
            "o hello da antiga");

        var fresh = new ScriptedSession(candidate: candidate);
        var freshRun = rig.Run(fresh);
        if (candidate)
        {
            // O prazo do primeiro quadro da candidata (valor único: o do batimento da API é outro).
            await WaitUntil(() => rig.Time.CreatedTimers.Any(t => t.Due == HelloWait), "o prazo do primeiro quadro armado");
        }
        else
        {
            await WaitUntil(() => rig.Connections.IsCurrent(fresh), "a nova ser a atual");
        }

        return (old, oldRun, fresh, freshRun);
    }

    private static async Task Finish(Task run, ScriptedSession session)
    {
        session.EndOfStream();
        await run.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    // ---- conexão comum (reconexão, inclusive depois de um 4411): substitui na hora, como sempre ----

    [Fact]
    public async Task APlainNewConnection_ReplacesTheOldAtOnce_WithReplaced()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: false);

        // Sem esperar nenhum quadro: a nova já é a atual e a antiga já saiu (espera 60 s antes de voltar).
        await oldRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        old.Closed.Should().Equal(AgentCloseReason.Replaced);
        rig.Connections.IsCurrent(fresh).Should().BeTrue();
        rig.Connections.TryGet(Slug, out var routed).Should().BeTrue();
        routed.Should().BeSameAs(fresh);

        await Finish(freshRun, fresh);
    }

    [Fact]
    public async Task AFrameFromTheReplacedOld_IsDiscarded_AndDoesNotCloseItByPolicy()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: false, oldCompletesOnClose: false);

        old.Push(KeepAlive());
        old.Push(Hello(handover: null));
        await Task.Delay(100, TestContext.Current.CancellationToken);

        old.Closed.Should().Equal([AgentCloseReason.Replaced], "quadro da sessão substituída é descartado, não vira fechamento 1008");
        rig.Connections.IsCurrent(fresh).Should().BeTrue("o hello da antiga não toma a vaga de volta");

        await Finish(freshRun, fresh);
        await Finish(oldRun, old);
    }

    // ---- candidata à passagem: fora do roteamento até o hello válido ----

    [Fact]
    public async Task ACandidate_IsNotRoutable_AndDoesNotCloseTheOld_UntilItsHelloArrives()
    {
        var rig = new Rig();
        var (old, _, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        // Comandos continuam indo para a antiga, que segue a atual e aberta.
        rig.Connections.IsCurrent(old).Should().BeTrue();
        rig.Connections.IsCurrent(fresh).Should().BeFalse();
        rig.Connections.TryGet(Slug, out var routed).Should().BeTrue();
        routed.Should().BeSameAs(old);
        old.Closed.Should().BeEmpty();

        await Finish(freshRun, fresh);
    }

    [Fact]
    public async Task ACandidate_WithAValidHandoverHello_IsPromoted_AndTheOldGetsHandover_WithoutADrop()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        fresh.Push(Hello(handover: true));
        await oldRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        old.Closed.Should().Equal(AgentCloseReason.Handover);
        rig.Connections.IsCurrent(fresh).Should().BeTrue();
        rig.Connected.Should().BeTrue("a saída da antiga não derruba a presença");
        rig.Connections.IsInGrace(Slug).Should().BeFalse("nenhuma queda foi aberta");

        await Finish(freshRun, fresh);
    }

    [Fact]
    public async Task ACandidate_WhenTheOldNeverDeclaredTheHandoverCapability_ReplacesItWithReplaced_NotHandover()
    {
        // A antiga que não declarou entender o 4410 sairia sem sentido dele (reconectaria e tiraria a nova do lugar): com
        // "replaced", que qualquer versão entende, ela espera antes de voltar.
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true, oldKnowsHandover: false);

        fresh.Push(Hello(handover: true));
        await oldRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        old.Closed.Should().Equal(AgentCloseReason.Replaced);
        rig.Connections.IsCurrent(fresh).Should().BeTrue();
        await WaitUntil(() => fresh.Sent.Count > 0, "a confirmação enviada");

        await Finish(freshRun, fresh);
    }

    [Fact]
    public async Task TheOldThatLeavesByHandover_IsClosedOnlyAfterItsPendingCommandsAnswer_AndTheAnswerIsDelivered()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);
        var commandId = Guid.CreateVersion7();
        using var pending = rig.Correlator.Expect(Slug, commandId);
        pending.TryBeginSend(old).Should().BeTrue();

        fresh.Push(Hello(handover: true));
        await WaitUntil(() => rig.Connections.IsCurrent(fresh), "a nova ser a atual");
        await Task.Delay(100, TestContext.Current.CancellationToken);
        old.Closed.Should().BeEmpty("a antiga ainda tem um comando em curso e a nova não a derruba antes da resposta");

        // A sessão que saiu por passagem ainda entrega a resposta (a de uma substituída seria descartada).
        old.Push(CommandResult(commandId));
        var reply = await pending.Reply.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        reply.CorrelationId.Should().Be(commandId);
        reply.Ok.Should().BeTrue();

        await AdvanceUntil(rig, oldRun);
        old.Closed.Should().Equal(AgentCloseReason.Handover);

        await Finish(freshRun, fresh);
    }

    [Fact]
    public async Task TheOldThatLeavesByHandover_IsClosedAnywayWhenItsCommandNeverAnswers()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);
        using var pending = rig.Correlator.Expect(Slug, Guid.CreateVersion7());
        pending.TryBeginSend(old).Should().BeTrue();

        fresh.Push(Hello(handover: true));
        await WaitUntil(() => rig.Connections.IsCurrent(fresh), "a nova ser a atual");

        await AdvanceUntil(rig, oldRun);

        old.Closed.Should().Equal([AgentCloseReason.Handover], "passado o prazo a antiga sai mesmo sem a resposta");
        await Finish(freshRun, fresh);
    }

    [Fact]
    public async Task AResultFromAReplacedOld_IsStillDiscarded()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: false, oldCompletesOnClose: false);
        var commandId = Guid.CreateVersion7();
        using var pending = rig.Correlator.Expect(Slug, commandId);
        pending.TryBeginSend(old).Should().BeTrue();

        old.Push(CommandResult(commandId));
        await Task.Delay(100, TestContext.Current.CancellationToken);

        pending.Reply.IsCompleted.Should().BeFalse("só a sessão que saiu por passagem entrega resposta depois de sair");

        await Finish(freshRun, fresh);
        await Finish(oldRun, old);
    }

    [Fact]
    public async Task ACandidate_WithAPlainHello_IsDropped_AndTheOldStaysCurrent()
    {
        // Quem se apresenta como candidata só vale com handover true e instanceId: um hello comum não a promove nem fecha a antiga.
        // Uma conexão comum conecta SEM o cabeçalho.
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        fresh.Push(Hello(handover: null));
        await freshRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        fresh.Closed.Should().Equal(AgentCloseReason.PolicyViolation);
        fresh.Sent.Should().BeEmpty("nenhuma confirmação para quem não foi promovida");
        old.Closed.Should().BeEmpty();
        rig.Connections.IsCurrent(old).Should().BeTrue();
        rig.Connections.IsCurrent(fresh).Should().BeFalse();

        await Finish(oldRun, old);
    }

    [Fact]
    public async Task ACandidate_WithHandoverFalse_IsDropped_AndTheOldStaysCurrent()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        fresh.Push(Hello(handover: false));
        await freshRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        fresh.Closed.Should().Equal(AgentCloseReason.PolicyViolation);
        old.Closed.Should().BeEmpty();
        rig.Connections.IsCurrent(old).Should().BeTrue();

        await Finish(oldRun, old);
    }

    [Fact]
    public async Task APromotedCandidate_GetsTheConfirmation_First_WithTheInstanceIdAndTheHelloId()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        var hello = Hello(handover: true);
        fresh.Push(hello);
        await oldRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await WaitUntil(() => fresh.Sent.Count > 0, "a confirmação enviada");

        var helloJson = JsonNode.Parse(hello)!;
        var ack = JsonNode.Parse(fresh.Sent[0])!;
        ack["type"]!.GetValue<string>().Should().Be("agent.handover.accepted.v1");
        ack["source"]!.GetValue<string>().Should().Be("api");
        ack["target"]!.GetValue<string>().Should().Be($"agent:{Slug}");
        ack["body"]!["instanceId"]!.GetValue<string>().Should().Be(helloJson["body"]!["instanceId"]!.GetValue<string>());
        ack["correlationId"]!.GetValue<string>().Should().Be(helloJson["id"]!.GetValue<string>());
        old.Closed.Should().Equal(AgentCloseReason.Handover);

        await Finish(freshRun, fresh);
    }

    [Fact]
    public async Task APlainConnection_NeverGetsTheConfirmation()
    {
        var rig = new Rig();
        var (_, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: false);
        await oldRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        fresh.Push(Hello(handover: null));
        await Task.Delay(100, TestContext.Current.CancellationToken);

        fresh.Sent.Should().NotContain(json => json.Contains("agent.handover.accepted.v1", StringComparison.Ordinal));

        await Finish(freshRun, fresh);
    }

    [Fact]
    public async Task ACandidate_ThatReconnectsAfterALostConfirmation_IsPromotedAgain_WithoutClosingAnyoneElse()
    {
        // A 1ª conexão da versão nova foi promovida (a antiga saiu), mas a confirmação se perdeu e a conexão caiu: a reconexão volta
        // como candidata (o agente só deixa de ser candidato com a confirmação) e entra de novo, sem derrubar mais nada.
        var rig = new Rig();
        var (old, oldRun, first, firstRun) = await ConnectAsync(rig, candidate: true);
        first.Push(Hello(handover: true));
        await oldRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await Finish(firstRun, first);

        var again = new ScriptedSession(candidate: true);
        var againRun = rig.Run(again);
        again.Push(Hello(handover: true));
        await WaitUntil(() => rig.Connections.IsCurrent(again), "a reconexão candidata ser a atual");
        await WaitUntil(() => again.Sent.Count > 0, "a confirmação da reconexão");

        old.Closed.Should().Equal(AgentCloseReason.Handover);
        again.Closed.Should().BeEmpty();

        await Finish(againRun, again);
    }

    [Fact]
    public async Task ACandidate_ThatEndsBeforeItsHello_LeavesTheOldCurrent_WithoutAnyClosing()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        await Finish(freshRun, fresh);

        oldRun.IsCompleted.Should().BeFalse();
        old.Closed.Should().BeEmpty("a antiga nunca sai por causa de uma candidata que não deu certo");
        rig.Connections.IsCurrent(old).Should().BeTrue();
        rig.Connected.Should().BeTrue();
        rig.Connections.IsInGrace(Slug).Should().BeFalse();
        rig.Connections.TryGet(Slug, out var routed).Should().BeTrue();
        routed.Should().BeSameAs(old);

        await Finish(oldRun, old);
    }

    [Fact]
    public async Task ACandidate_ThatSendsNothingInTime_IsDropped_AndTheOldStaysCurrent()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        rig.Time.Advance(HelloWait);
        await freshRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        fresh.Closed.Should().BeEmpty("fechada em silêncio, sem motivo de política");
        old.Closed.Should().BeEmpty();
        rig.Connections.IsCurrent(old).Should().BeTrue();
        oldRun.IsCompleted.Should().BeFalse();

        await Finish(oldRun, old);
    }

    [Fact]
    public async Task ACandidate_WhoseFirstFrameIsNotAHello_IsDropped_AndTheOldStaysCurrent()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        fresh.Push(KeepAlive());
        await freshRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        fresh.Closed.Should().Equal(AgentCloseReason.PolicyViolation);
        old.Closed.Should().BeEmpty();
        rig.Connections.IsCurrent(old).Should().BeTrue();

        await Finish(oldRun, old);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("nao-e-uuid")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    public async Task ACandidate_WithHandoverTrueButWithoutAValidInstanceId_IsDropped_AndTheOldStaysCurrent(string? instanceId)
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        fresh.Push(HandoverHello(instanceId));
        await freshRun.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        fresh.Closed.Should().Equal(AgentCloseReason.PolicyViolation);
        old.Closed.Should().BeEmpty();
        rig.Connections.IsCurrent(old).Should().BeTrue();
        rig.Connections.IsCurrent(fresh).Should().BeFalse();

        await Finish(oldRun, old);
    }

    [Fact]
    public async Task ACandidate_WithNothingToReplace_BecomesTheCurrentOneWithAValidHello()
    {
        var rig = new Rig();
        var fresh = new ScriptedSession(candidate: true);
        var freshRun = rig.Run(fresh);

        fresh.Push(Hello(handover: true));
        await WaitUntil(() => rig.Connections.IsCurrent(fresh), "a candidata ser a atual");

        fresh.Closed.Should().BeEmpty();
        await Finish(freshRun, fresh);
    }

    [Fact]
    public async Task AFrameFromTheOld_WhileACandidateWaits_IsHandledNormally()
    {
        var rig = new Rig();
        var (old, oldRun, fresh, freshRun) = await ConnectAsync(rig, candidate: true);

        old.Push(KeepAlive());
        await Task.Delay(100, TestContext.Current.CancellationToken);

        old.Closed.Should().BeEmpty();
        rig.Connections.IsCurrent(old).Should().BeTrue();

        await Finish(freshRun, fresh);
        await Finish(oldRun, old);
    }

    [Fact]
    public async Task AFrameFromARevokedSession_StillClosesItByPolicy()
    {
        var rig = new Rig();
        var session = new ScriptedSession(completeOnClose: false);
        var run = rig.Run(session);
        await WaitUntil(() => rig.Connections.IsCurrent(session), "a sessão ser a atual");

        await rig.Connections.CloseAsync(Slug, AgentCloseReason.Revoked, CancellationToken.None);
        session.Push(KeepAlive());
        await run.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        session.Closed.Should().Equal(AgentCloseReason.Revoked, AgentCloseReason.PolicyViolation);
    }

    [Fact]
    public void TheModuleInfo_ListsTheHandoverFeature()
    {
        GetModuleInfoHandler.AgentFeatures.Should().Contain("agent.handover.v1");
    }
}
