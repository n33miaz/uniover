using ReflectionAssembly = System.Reflection.Assembly;
using System.Text;
using System.Threading.Channels;
using ArchUnitNET.Domain;
using ArchUnitNET.Loader;
using ArchUnitNET.xUnitV3;
using AwesomeAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Ports;
using UniOver.Modules.Devices.Transport.WebSocket;
using static ArchUnitNET.Fluent.ArchRuleDefinition;
using static UniOver.ArchitectureTests.ModuleDiscovery;

namespace UniOver.ArchitectureTests;

/// <summary>
/// Prova que o transporte do agente é um adaptador: só o projeto do WebSocket conhece <c>System.Net.WebSockets</c>, a
/// API pública do módulo não conhece ASP.NET, e um transporte falso passa mensagens pelo núcleo sem nenhum WebSocket.
/// Trocar o transporte (por exemplo, MQTT) é, portanto, trocar o adaptador.
/// </summary>
public class TransportIsolationTests
{
    private static readonly ReflectionAssembly Interior = DiscoveredModules.Single(m => m.Name == "Devices").Interior;
    private static readonly ReflectionAssembly Contracts = DiscoveredModules.Single(m => m.Name == "Devices").Contracts;
    private static readonly ReflectionAssembly Adapter = typeof(WebSocketTransportModule).Assembly;

    // O assembly do WebSocket entra na análise: sem ele o ArchUnit ignora dependências para fora do que foi carregado
    // e a regra passaria no vazio.
    private static readonly Architecture Architecture = new ArchLoader()
        .LoadAssemblies(Interior, Contracts, Adapter, typeof(System.Net.WebSockets.WebSocket).Assembly)
        .Build();

    private const string WebSocketNamespace = @"^System\.Net\.WebSockets(\..*)?$";

    [Fact]
    public void DevicesInterior_DoesNotReferenceWebSockets()
    {
        Types().That().ResideInAssembly(Interior)
            .Should().NotDependOnAnyTypesThat().ResideInNamespaceMatching(WebSocketNamespace)
            .Check(Architecture);
    }

    [Fact]
    public void DevicesContracts_DoNotReferenceAspNetOrWebSockets()
    {
        Types().That().ResideInAssembly(Contracts)
            .Should().NotDependOnAnyTypesThat().ResideInNamespaceMatching(@"^(Microsoft\.AspNetCore|System\.Net\.WebSockets)(\..*)?$")
            .Check(Architecture);
    }

    [Fact]
    public void TheWebSocketAdapter_IsTheOneThatUsesWebSockets()
    {
        // Prova de que a regra morde: no adaptador a dependência existe, então a regra acima não passa no vazio.
        Types().That().ResideInAssembly(Adapter).And().HaveNameStartingWith("WebSocketAgentSession")
            .Should().DependOnAny(Types().That().ResideInNamespaceMatching(WebSocketNamespace))
            .Check(Architecture);
    }

    [Fact]
    public void TheCoreDoesNotReferenceTheAdapter()
    {
        Interior.GetReferencedAssemblies().Select(a => a.Name)
            .Should().NotContain(Adapter.GetName().Name, "o núcleo depende da porta, nunca do adaptador");
    }

    private sealed class FakeSession(string agentId) : IAgentSession
    {
        private readonly Channel<byte[]> _inbound = Channel.CreateUnbounded<byte[]>();
        private readonly Channel<byte[]> _outbound = Channel.CreateUnbounded<byte[]>();

        public string AgentId { get; } = agentId;

        public ChannelReader<byte[]> Sent => _outbound.Reader;

        public void Receive(string json) => _inbound.Writer.TryWrite(Encoding.UTF8.GetBytes(json));

        public void Hangup() => _inbound.Writer.TryComplete();

        public async ValueTask<byte[]?> ReceiveAsync(CancellationToken cancellationToken)
        {
            try
            {
                return await _inbound.Reader.ReadAsync(cancellationToken);
            }
            catch (ChannelClosedException)
            {
                return null;
            }
        }

        public ValueTask<bool> SendAsync(ReadOnlyMemory<byte> envelope, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_outbound.Writer.TryWrite(envelope.ToArray()));

        public Task CloseAsync(AgentCloseReason reason, CancellationToken cancellationToken)
        {
            _inbound.Writer.TryComplete();
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeTransport : IAgentTransport
    {
        private readonly Channel<IAgentSession> _sessions = Channel.CreateUnbounded<IAgentSession>();

        public string Name => "fake";

        public void Connect(IAgentSession session) => _sessions.Writer.TryWrite(session);

        public IAsyncEnumerable<IAgentSession> AcceptSessionsAsync(CancellationToken cancellationToken) =>
            _sessions.Reader.ReadAllAsync(cancellationToken);
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (!condition())
        {
            (DateTime.UtcNow < deadline).Should().BeTrue("a condição deveria ter sido atingida");
            await Task.Delay(20, TestContext.Current.CancellationToken);
        }
    }

    [Fact]
    public async Task AFakeTransport_PassesMessagesThroughTheCore_WithoutAnyWebSocket()
    {
        var transport = new FakeTransport();
        var services = new ServiceCollection();
        services.AddLogging();
        // Sem graça de presença: o teste confere a queda do agente na hora, não depois da espera de reconexão.
        services.AddDevicesTransport(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Modules:Devices:Transport:PresenceGraceSeconds"] = "0" })
            .Build());
        services.AddSingleton<IAgentTransport>(transport);
        await using var provider = services.BuildServiceProvider();

        var hosted = provider.GetServices<IHostedService>().ToList();
        foreach (var service in hosted)
        {
            await service.StartAsync(CancellationToken.None);
        }

        try
        {
            var session = new FakeSession("pc-casa");
            transport.Connect(session);
            var presence = provider.GetRequiredService<IAgentPresenceReader>();
            await WaitUntilAsync(() => presence.Get("pc-casa")?.Connected == true);

            // Entrada: o núcleo valida e trata um agent.hello.v1 vindo do transporte falso.
            session.Receive(
                """
                { "v": 1, "id": "0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e9f", "type": "agent.hello.v1", "source": "agent:pc-casa", "target": "api",
                  "ts": "2026-10-19T12:00:00Z", "correlationId": null, "body": { "agentVersion": "1.0.0", "capabilities": ["tv.remote"] } }
                """);
            await WaitUntilAsync(() => presence.Get("pc-casa")?.AgentVersion == "1.0.0");

            // Saída: um comando de outro módulo chega ao transporte falso pelo gateway.
            var body = System.Text.Json.JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["key"] = "MUTE" });
            var sent = await provider.GetRequiredService<IAgentGateway>()
                .SendAsync("pc-casa", new OutboundMessage("tv.key.v1", body), TestContext.Current.CancellationToken);
            sent.IsSuccess.Should().BeTrue();
            var frame = await session.Sent.ReadAsync(new CancellationTokenSource(TimeSpan.FromSeconds(15)).Token);
            Encoding.UTF8.GetString(frame).Should().Contain("\"tv.key.v1\"").And.Contain("agent:pc-casa");

            // Fim: o agente some e a presença cai.
            session.Hangup();
            await WaitUntilAsync(() => presence.Get("pc-casa")?.Connected == false);
        }
        finally
        {
            foreach (var service in hosted)
            {
                await service.StopAsync(CancellationToken.None);
            }
        }
    }
}
