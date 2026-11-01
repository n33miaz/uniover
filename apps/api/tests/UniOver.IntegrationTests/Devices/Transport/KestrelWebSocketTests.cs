using System.Net.WebSockets;
using System.Text;
using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.IntegrationTests.Devices.Transport;

/// <summary>
/// Uma conexão com o Kestrel de verdade (soquete real, <c>ClientWebSocket</c>). O servidor de teste fornece o
/// suporte a WebSocket por conta própria; só o Kestrel prova que a rota liga o <c>UseWebSockets</c> sozinha.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class KestrelWebSocketTests(PostgresFixture postgres)
{
    [Fact]
    public async Task RealSocket_ConnectsWithTheHeaderToken_AndTheHelloReachesThePresence()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        await using var factory = StartKestrel(app);
        using var socket = new ClientWebSocket();
        using var timeout = new CancellationTokenSource(FakeAgent.Patience);
        await ConnectAsync(factory, app, socket, timeout.Token);

        var hello = FakeAgent.Envelope(
            "agent.hello.v1", $"agent:{app.Agent.Slug}",
            new System.Text.Json.Nodes.JsonObject
            {
                ["agentVersion"] = "8.0.0",
                ["capabilities"] = new System.Text.Json.Nodes.JsonArray(),
            });
        await socket.SendAsync(Encoding.UTF8.GetBytes(hello), WebSocketMessageType.Text, true, timeout.Token);

        var presence = factory.Services.GetRequiredService<IAgentPresenceReader>();
        await TransportApp.WaitUntilAsync(() => presence.Get(app.Agent.Slug)?.AgentVersion == "8.0.0", "hello pelo Kestrel");

        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "fim", timeout.Token);
        await TransportApp.WaitUntilAsync(() => presence.Get(app.Agent.Slug)?.Connected == false, "desconexão pelo Kestrel");
    }

    /// <summary>
    /// Deploy no Render: o processo antigo recebe o pedido de parada com o agente conectado. O agente precisa ver o
    /// fechamento 1012 (reinício do serviço), e não uma conexão que some sem quadro de fechamento, porque é pelo código
    /// que ele sabe que deve voltar na hora.
    /// </summary>
    [Fact]
    public async Task HostStop_ClosesTheAgentWithServiceRestart_InsteadOfDroppingTheSocket()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var factory = StartKestrel(app);
        using var socket = new ClientWebSocket();
        using var timeout = new CancellationTokenSource(FakeAgent.Patience);
        await ConnectAsync(factory, app, socket, timeout.Token);
        var presence = factory.Services.GetRequiredService<IAgentPresenceReader>();
        await TransportApp.WaitUntilAsync(() => presence.Get(app.Agent.Slug)?.Connected == true, "agente conectado");

        var stopping = factory.Services.GetRequiredService<IHost>().StopAsync(timeout.Token);

        var buffer = new byte[4096];
        WebSocketReceiveResult? closing = null;
        while (closing is null || closing.MessageType != WebSocketMessageType.Close)
        {
            closing = await socket.ReceiveAsync(buffer, timeout.Token);
        }

        closing.CloseStatus.Should().Be((WebSocketCloseStatus)1012);
        closing.CloseStatusDescription.Should().Be("service_restart");
        await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "ok", timeout.Token);
        await stopping;
    }

    private static EdgeFactory StartKestrel(TransportApp app)
    {
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = app.App.Database.RuntimeConnection,
            ["Modules:Identity:Jwt:SigningKey"] = IdentityApp.NewKey(),
            ["RateLimiting:pairing:Permitted"] = "100000",
            // Sem graça de presença: o teste confere a queda na hora.
            ["Modules:Devices:Transport:PresenceGraceSeconds"] = "0",
        };
        var factory = new EdgeFactory("Development", settings);
        factory.UseKestrel(0);
        factory.StartServer();
        return factory;
    }

    private static async Task ConnectAsync(EdgeFactory factory, TransportApp app, ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var address = new Uri(factory.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
            .Features.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()!.Addresses.First());
        socket.Options.SetRequestHeader("Authorization", $"Bearer {app.Agent.Token}");
        await socket.ConnectAsync(new Uri($"ws://{address.Host}:{address.Port}/api/v1/devices/agents/{app.Agent.Slug}/ws"), cancellationToken);
    }
}
