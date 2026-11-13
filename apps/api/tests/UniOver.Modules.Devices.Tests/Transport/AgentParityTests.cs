using System.Text.Json;
using AwesomeAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;

namespace UniOver.Modules.Devices.Tests.Transport;

/// <summary>
/// Os números da paridade com o Unified Remote, com relógio falso: janela de 30 min, teto de amostras, percentil pelo posto mais
/// próximo, segundos de uso (não mensagens) e o gateway alimentando tudo sem banco.
/// </summary>
public sealed class AgentParityTests
{
    private const string Agent = "pc-casa";
    private static readonly DateTimeOffset Start = new(2026, 11, 12, 12, 0, 0, TimeSpan.Zero);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static (AgentParity Parity, FakeTimeProvider Time) Rig()
    {
        var time = new FakeTimeProvider(Start);
        return (new AgentParity(time), time);
    }

    [Fact]
    public void Percentile_IsTheNearestRank_AndNullBelowFiveSamples()
    {
        AgentParity.Percentile([10, 20, 30, 40], 50).Should().BeNull("quatro amostras não dizem nada");
        int[] hundred = [.. Enumerable.Range(1, 100)];
        AgentParity.Percentile(hundred, 50).Should().Be(50);
        AgentParity.Percentile(hundred, 95).Should().Be(95);
        AgentParity.Percentile(hundred, 99).Should().Be(99);
        AgentParity.Percentile([5, 1, 4, 2, 3], 50).Should().Be(3, "a ordem de chegada não importa");
        AgentParity.Percentile([5, 1, 4, 2, 3], 99).Should().Be(5, "com cinco amostras o p99 é a maior");
    }

    [Fact]
    public void NothingMeasured_IsAllEmpty_AndTheAgentIsLeftOut()
    {
        var (parity, _) = Rig();

        parity.Snapshot().Should().BeEmpty();
        var none = parity.Of(Agent);
        none.DirectPercent.Should().BeNull();
        none.ReplyP50Ms.Should().BeNull();
        none.ReplyP95Ms.Should().BeNull();
        none.LoopLagP99Ms.Should().BeNull();
        none.Unanswered.Should().Be(0);
    }

    [Fact]
    public void CloudUse_CountsSecondsNotMessages()
    {
        var (parity, time) = Rig();

        // Um arrasto pela nuvem: 31 movimentos por segundo durante 3 s são 3 segundos de uso, não 93.
        for (var second = 0; second < 3; second++)
        {
            for (var i = 0; i < 31; i++)
            {
                parity.OnCloudInput(Agent);
                time.Advance(TimeSpan.FromMilliseconds(32));
            }

            time.Advance(TimeSpan.FromMilliseconds(1_000 - (31 * 32) + 8));
        }

        parity.Of(Agent).CloudSeconds.Should().Be(3);
    }

    [Fact]
    public void TheDirectShare_IsTheDirectSecondsOverAllSeconds()
    {
        var (parity, time) = Rig();
        parity.OnDirectUse(Agent, 45);
        for (var i = 0; i < 5; i++)
        {
            parity.OnCloudInput(Agent);
            time.Advance(TimeSpan.FromSeconds(1));
        }

        var now = parity.Of(Agent);
        now.DirectSeconds.Should().Be(45);
        now.CloudSeconds.Should().Be(5);
        now.DirectPercent.Should().Be(90);

        parity.OnDirectUse(Agent, 0);
        parity.OnDirectUse(Agent, -3);
        parity.Of(Agent).DirectSeconds.Should().Be(45, "zero e negativo não contam");
        parity.OnDirectUse(Agent, 10_000);
        parity.Of(Agent).DirectSeconds.Should().Be(45 + AgentParity.MaxDirectSecondsPerReport, "um relatório tem teto");
    }

    [Fact]
    public void ReplyAge_HasP50AndP95_FromTheWindow()
    {
        var (parity, time) = Rig();
        for (var ms = 1; ms <= 20; ms++)
        {
            parity.OnReply(Agent, TimeSpan.FromMilliseconds(ms * 10));
            time.Advance(TimeSpan.FromSeconds(1));
        }

        var now = parity.Of(Agent);
        now.ReplySamples.Should().Be(20);
        now.ReplyP50Ms.Should().Be(100);
        now.ReplyP95Ms.Should().Be(190);
    }

    [Fact]
    public void TheWindowIsThirtyMinutes_OlderSamplesLeave()
    {
        var (parity, time) = Rig();
        for (var i = 0; i < 5; i++)
        {
            parity.OnReply(Agent, TimeSpan.FromMilliseconds(900));
            parity.OnLoopLag(Agent, 400);
        }

        parity.OnUnanswered(Agent);
        parity.OnDirectUse(Agent, 30);

        time.Advance(TimeSpan.FromMinutes(20));
        for (var i = 0; i < 5; i++)
        {
            parity.OnReply(Agent, TimeSpan.FromMilliseconds(40));
            parity.OnLoopLag(Agent, 12);
        }

        var mixed = parity.Of(Agent);
        mixed.ReplySamples.Should().Be(10);
        mixed.Unanswered.Should().Be(1);
        mixed.LoopLagP99Ms.Should().Be(400);

        // Passados 30 min das primeiras amostras, só as recentes ficam.
        time.Advance(TimeSpan.FromMinutes(10));
        var recent = parity.Of(Agent);
        recent.ReplySamples.Should().Be(5);
        recent.ReplyP95Ms.Should().Be(40);
        recent.LoopLagP99Ms.Should().Be(12);
        recent.Unanswered.Should().Be(0);
        recent.DirectSeconds.Should().Be(0);
        recent.DirectPercent.Should().BeNull();

        // E depois de mais 30 min sem nada, o agente sai da lista.
        time.Advance(TimeSpan.FromMinutes(31));
        parity.Snapshot().Should().BeEmpty();
    }

    [Fact]
    public void EachSeries_IsCapped()
    {
        var (parity, _) = Rig();
        for (var i = 0; i < AgentParity.MaxSamples + 500; i++)
        {
            parity.OnReply(Agent, TimeSpan.FromMilliseconds(i));
        }

        parity.Of(Agent).ReplySamples.Should().Be(AgentParity.MaxSamples, "as mais velhas saem primeiro");
        parity.Of(Agent).ReplyP50Ms.Should().BeGreaterThan(500, "as que ficaram são as recentes");
    }

    [Fact]
    public void LoopLag_CountsOnlyValidSamples()
    {
        var (parity, _) = Rig();
        parity.OnLoopLag(Agent, -1);
        parity.Of(Agent).LoopLagSamples.Should().Be(0, "sem amostra válida a tela mostra \"—\"");

        foreach (var lag in new[] { 3, 8, 5, 250, 4, 6 })
        {
            parity.OnLoopLag(Agent, lag);
        }

        var now = parity.Of(Agent);
        now.LoopLagSamples.Should().Be(6);
        now.LoopLagP99Ms.Should().Be(250);
    }

    [Theory]
    [InlineData("pc.pointer.v1", true)]
    [InlineData("pc.pointer.zoom.v1", true)]
    [InlineData("pc.click.v2", true)]
    [InlineData("pc.key.v2", true)]
    [InlineData("pc.text.v2", true)]
    [InlineData("pc.media.v1", true)]
    [InlineData("pc.volume.v1", true)]
    [InlineData("tv.key.v3", true)]
    [InlineData("tv.text.v1", true)]
    [InlineData("pc.power.v1", false)]
    [InlineData("pc.app.launch.v1", false)]
    [InlineData("pc.rtc.offer.v1", false)]
    [InlineData("tv.power.off.v1", false)]
    [InlineData("tv.app.launch.v1", false)]
    public void OnlyKeysMouseTextAndMedia_AreInput(string type, bool input) =>
        AgentParity.IsInput(type).Should().Be(input);

    private static OutboundMessage Message(string type, string body) => new(type, JsonDocument.Parse(body).RootElement.Clone());

    [Fact]
    public async Task TheGateway_FeedsCloudSecondsRepliesAndUnanswered()
    {
        var rig = new RestartRig();
        var parity = new AgentParity(rig.Time);
        var gateway = new AgentGateway(
            rig.Connections, rig.Factory, rig.Correlator, rig.Options, rig.Time, NullLogger<AgentGateway>.Instance, agentParity: parity);
        var session = new RecordingSession(Agent);
        rig.Connections.Attach(session, rig.Time.GetUtcNow());

        // Movimento sem resposta: conta como segundo de uso pela nuvem.
        (await gateway.SendAsync(Agent, Message("pc.pointer.v1", """{"dx":3,"dy":1}"""), Ct)).IsSuccess.Should().BeTrue();

        // Cinco teclas respondidas, uma por segundo.
        for (var i = 0; i < 5; i++)
        {
            rig.Time.Advance(TimeSpan.FromSeconds(1));
            var key = gateway.RequestAsync(Agent, Message("tv.key.v3", """{"key":"VOLUME_UP"}"""), TimeSpan.FromSeconds(8), Ct);
            var id = JsonDocument.Parse(session.Sent[^1]).RootElement.GetProperty("id").GetGuid();
            rig.Correlator.TryComplete(Agent, id, new AgentReply(id, true, null)).Should().BeTrue();
            (await key.WaitAsync(TimeSpan.FromSeconds(10), Ct)).IsSuccess.Should().BeTrue();
        }

        // Um pedido que não é entrada (a energia) e fica sem resposta: conta como sem resposta, nunca como uso nem como idade.
        rig.Time.Advance(TimeSpan.FromSeconds(1));
        var power = gateway.RequestAsync(Agent, Message("pc.power.v1", """{"action":"LOCK"}"""), TimeSpan.FromSeconds(8), Ct);
        rig.Time.Advance(TimeSpan.FromSeconds(8));
        (await power.WaitAsync(TimeSpan.FromSeconds(10), Ct)).Error.Code.Should().Be(AgentErrors.TimeoutCode);

        var now = parity.Of(Agent);
        now.CloudSeconds.Should().Be(6);
        now.ReplySamples.Should().Be(5);
        now.ReplyP50Ms.Should().NotBeNull();
        now.Unanswered.Should().Be(1);
        now.DirectPercent.Should().Be(0);
    }
}
