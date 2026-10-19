using System.Net.WebSockets;
using System.Text;
using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;
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

        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = app.App.Database.RuntimeConnection,
            ["Modules:Identity:Jwt:SigningKey"] = IdentityApp.NewKey(),
            ["RateLimiting:pairing:Permitted"] = "100000",
        };
        await using var factory = new EdgeFactory("Development", settings);
        factory.UseKestrel(0);
        factory.StartServer();
        var address = new Uri(factory.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
            .Features.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()!.Addresses.First());

        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Authorization", $"Bearer {app.Agent.Token}");
        using var timeout = new CancellationTokenSource(FakeAgent.Patience);
        await socket.ConnectAsync(new Uri($"ws://{address.Host}:{address.Port}/api/v1/devices/agents/{app.Agent.Slug}/ws"), timeout.Token);

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
}
