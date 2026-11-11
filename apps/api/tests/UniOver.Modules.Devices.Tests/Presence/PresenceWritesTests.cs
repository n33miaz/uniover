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
using UniOver.Modules.Devices.Features.Presence;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Tests.Presence;

/// <summary>
/// O banco do plano gratuito dorme sem consulta: um agente conectado dia e noite não pode gerar escrita a cada batimento.
/// Toda escrita do resumo de presença começa abrindo um escopo (para o <c>DbContext</c>), então contar escopos é contar idas ao banco.
/// </summary>
public sealed class PresenceWritesTests
{
    private const string Slug = "pc-casa";
    private static readonly DateTimeOffset Start = new(2026, 11, 10, 12, 0, 0, TimeSpan.Zero);

    private sealed class FixedClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; } = now;
    }

    private sealed class CountingScopes(IServiceScopeFactory inner) : IServiceScopeFactory
    {
        private int _created;

        public int Created => Volatile.Read(ref _created);

        public IServiceScope CreateScope()
        {
            Interlocked.Increment(ref _created);
            return inner.CreateScope();
        }
    }

    private sealed class ScriptedSession : IAgentSession
    {
        private readonly Channel<byte[]> _frames = Channel.CreateUnbounded<byte[]>();

        public string AgentId => Slug;

        public void Push(string json) => _frames.Writer.TryWrite(Encoding.UTF8.GetBytes(json));

        public void EndOfStream() => _frames.Writer.TryComplete();

        public async ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken) =>
            await _frames.Reader.WaitToReadAsync(cancellationToken) ? await _frames.Reader.ReadAsync(cancellationToken) : null;

        public ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken) => ValueTask.FromResult(true);

        public Task CloseAsync(AgentCloseReason reason, CancellationToken cancellationToken)
        {
            _frames.Writer.TryComplete();
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
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

    private static string Hello() => Envelope("agent.hello.v1", new JsonObject
    {
        ["agentVersion"] = "2.0.0",
        ["capabilities"] = new JsonArray(JsonValue.Create("transport.keepalive.v1")),
    });

    private static string KeepAlive() => Envelope("agent.keepalive.v1", []);

    [Fact]
    public async Task HeartbeatsOfAConnectedAgent_NeverReachTheDatabase()
    {
        var time = new FakeTimeProvider(Start);
        var options = Options.Create(new DevicesTransportOptions());
        var presence = new InMemoryPresenceStore(time, options);
        var connections = new AgentConnections(presence, new SseBroadcaster<PresenceUpdate>(new SseStreamOptions()), null, time, options);
        var scopes = new CountingScopes(new ServiceCollection().BuildServiceProvider().GetRequiredService<IServiceScopeFactory>());
        var validator = new AgentEnvelopeValidator();
        var hub = new AgentHub(
            validator,
            new OutboundEnvelopeFactory(validator, new FixedClock(Start)),
            connections,
            new AgentPresencePersistence(scopes, NullLogger<AgentPresencePersistence>.Instance),
            new ReplyCorrelator(),
            new InMemoryAgentLogReports(time),
            scopes,
            options,
            time,
            NullLogger<AgentHub>.Instance);
        var session = new ScriptedSession();
        var run = hub.RunSessionAsync(session, CancellationToken.None);

        session.Push(Hello());
        await WaitUntil(() => presence.Get(Slug)?.AgentVersion == "2.0.0", "hello aceito");
        // Os quadros andam em ordem: quando o primeiro batimento é visto, o resumo do hello já foi tratado.
        time.Advance(TimeSpan.FromSeconds(1));
        session.Push(KeepAlive());
        await WaitUntil(() => presence.Get(Slug)?.LastMessageAt == Start.AddSeconds(1), "primeiro batimento");
        var afterHello = scopes.Created;
        afterHello.Should().BeGreaterThan(0, "conectar e o hello novo gravam o resumo: é o que o banco precisa saber");

        for (var minute = 1; minute <= 10; minute++)
        {
            time.Advance(TimeSpan.FromMinutes(1));
            session.Push(KeepAlive());
            var expected = Start.AddSeconds(1).AddMinutes(minute);
            await WaitUntil(() => presence.Get(Slug)?.LastMessageAt == expected, $"batimento do minuto {minute}");
        }

        scopes.Created.Should().Be(afterHello, "dez minutos de batimento: o 'visto agora' fica na memória, o banco dorme");
        presence.Get(Slug)!.LastMessageAt.Should().Be(Start.AddSeconds(1).AddMinutes(10), "a presença em memória segue viva para a tela");

        session.EndOfStream();
        await run;
        scopes.Created.Should().BeGreaterThan(afterHello, "desconectar grava o último sinal");
    }

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
}
