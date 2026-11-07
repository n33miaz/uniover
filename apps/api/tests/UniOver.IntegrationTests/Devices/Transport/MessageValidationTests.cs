using System.Net.WebSockets;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Features.Agents;

namespace UniOver.IntegrationTests.Devices.Transport;

[Collection(PostgresGroup.Name)]
public sealed class MessageValidationTests(PostgresFixture postgres)
{
    private static JsonObject Hello(string version = "1.0.0") =>
        new JsonObject { ["agentVersion"] = version, ["capabilities"] = new JsonArray("tv.remote") };

    [Fact]
    public async Task Hello_UpdatesVersionAndCapabilities()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();

        await agent.SendHelloAsync("2.5.0", "tv.remote", "tv.adb");

        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "2.5.0", "hello processado");
        var info = app.Presence.Get(app.Agent.Slug)!;
        info.Capabilities.Should().Equal("tv.remote", "tv.adb");
        info.Connected.Should().BeTrue();
        info.LastMessageAt.Should().NotBeNull();
    }

    [Fact]
    public async Task MinimumSupportedHello_IsAcceptedForAnOldAgent()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();

        // Campos e capacidades novos sao aditivos: o hello mais antigo valido continua entrando.
        await agent.SendTextAsync(agent.Envelope(
            "agent.hello.v1",
            new JsonObject { ["agentVersion"] = "0.1.0", ["capabilities"] = new JsonArray() }));

        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "0.1.0",
            "hello minimo processado");
        app.Presence.Get(app.Agent.Slug)!.Capabilities.Should().BeEmpty();
        agent.State.Should().Be(WebSocketState.Open);
    }

    [Fact]
    public async Task KeepAlives_KeepTheChannelActiveInBothDirections()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("2.5.0", "transport.keepalive.v1");
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("transport.keepalive.v1") == true,
            "capacidade de batimento processada");

        // O primeiro batimento sai logo depois do hello, sem esperar o período.
        var first = (await agent.ReceiveAnyAsync())!.Value;
        first.GetProperty("type").GetString().Should().Be("api.keepalive.v1");
        first.GetProperty("body").EnumerateObject().Should().BeEmpty();

        // O relógio do Host é falso: adiantar prova o batimento seguinte sem esperar 25 segundos reais.
        var incoming = agent.ReceiveAnyAsync();
        app.App.Time.Advance(TimeSpan.FromSeconds(25));
        var heartbeat = (await incoming)!.Value;
        heartbeat.GetProperty("type").GetString().Should().Be("api.keepalive.v1");
        heartbeat.GetProperty("body").EnumerateObject().Should().BeEmpty();

        var before = app.Presence.Get(app.Agent.Slug)!.LastMessageAt;
        app.App.Time.Advance(TimeSpan.FromSeconds(1));
        await agent.SendTextAsync(agent.Envelope("agent.keepalive.v1", new JsonObject()));
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)!.LastMessageAt > before,
            "batimento do agente processado");
        agent.State.Should().Be(WebSocketState.Open);
    }

    [Fact]
    public async Task TheFirstKeepAlive_LeavesRightAfterTheHelloIsAccepted_WithoutWaitingAPeriod()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();

        await agent.SendHelloAsync("2.5.0", "transport.keepalive.v1");
        var first = (await agent.ReceiveAnyAsync())!.Value;

        // O relógio falso não andou: só o hello pode ter disparado o batimento, não o temporizador do período.
        first.GetProperty("type").GetString().Should().Be("api.keepalive.v1");
        first.GetProperty("target").GetString().Should().Be($"agent:{app.Agent.Slug}");
    }

    [Fact]
    public async Task AnAgentWithoutTheKeepAliveCapability_NeverGetsAKeepAlive()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        // Sem fechar o agente à mão: a leitura pendente abaixo disputaria o socket; o app o fecha ao terminar.
        var agent = await app.ConnectAsync();

        await agent.SendHelloAsync("0.1.0", "tv.remote");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "0.1.0", "hello processado");

        // Sem a capacidade o laço só dorme: o 1º temporizador do período é a espera pelo hello, o 2º é o sono do laço.
        var period = app.App.Services.GetRequiredService<IOptions<DevicesTransportOptions>>().Value.ApplicationKeepAlive;
        int Timers() => app.App.Time.CreatedTimers.Count(t => t.Due == period);
        await TransportApp.WaitUntilAsync(() => Timers() >= 2, "laço do batimento dormindo");
        var next = agent.ReceiveAnyAsync();

        // Um período depois o laço acorda, confere a capacidade, não envia e volta a dormir (3º temporizador).
        app.App.Time.Advance(period);
        await TransportApp.WaitUntilAsync(() => Timers() >= 3, "laço do batimento acordou e voltou a dormir");

        next.IsCompleted.Should().BeFalse("versões sem a capacidade não recebem tipos novos");
    }

    [Fact]
    public async Task OutOfContractMessages_AreRefused_LoggedWithoutTheBody_AndTheConnectionSurvives()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var slug = app.Agent.Slug;
        var marker = "corpo-secreto-" + Guid.NewGuid().ToString("N");

        var extraField = JsonNode.Parse(agent.Envelope("agent.hello.v1", Hello()))!;
        extraField["intruso"] = marker;

        var refused = new Dictionary<string, string>
        {
            ["schema_violation"] = extraField.ToJsonString(),
            ["unknown_type"] = agent.Envelope("coisa.nova.v1", new JsonObject { ["x"] = marker }),
            ["source_mismatch"] = FakeAgent.Envelope("agent.hello.v1", "agent:outro", Hello()),
            ["target_mismatch"] = FakeAgent.Envelope("agent.hello.v1", $"agent:{slug}", Hello(), target: "agent:outro"),
            ["wrong_direction"] = agent.Envelope("tv.key.v1", new JsonObject { ["key"] = "POWER" }),
            ["invalid_json"] = "isto não é json " + marker,
            ["unsupported_version"] = FakeAgent.Envelope("agent.hello.v1", $"agent:{slug}", Hello(), version: 2),
        };

        // Uma por uma, esperando o registro: 7 recusas passariam do limite de 5 por minuto, então o relógio
        // anda 61 s entre as duas levas para a janela esvaziar.
        var index = 0;
        foreach (var (reason, text) in refused)
        {
            await agent.SendTextAsync(text);
            await TransportApp.WaitUntilAsync(
                () => app.App.Logs.Lines.Any(l => l.Contains("recusada", StringComparison.Ordinal) && l.Contains(reason, StringComparison.Ordinal)),
                $"recusa {reason} registrada");
            if (++index % 4 == 0)
            {
                app.App.Time.Advance(TimeSpan.FromSeconds(61));
            }
        }

        // Sobreviveu: a próxima mensagem boa é tratada.
        await agent.SendHelloAsync("9.9.9");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(slug)?.AgentVersion == "9.9.9", "hello depois das recusas");

        var logs = app.App.Logs.Lines.Where(l => l.Contains("recusada", StringComparison.Ordinal)).ToList();
        logs.Should().OnlyContain(l => l.Contains(slug, StringComparison.Ordinal), "o registro diz qual agente");
        string.Join('\n', app.App.Logs.Lines).Should().NotContain(marker, "o corpo recebido nunca vai para o log");
    }

    [Fact]
    public async Task RefusedMessageWithACorrelationId_GetsAnInvalidMessageResult()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var correlation = Guid.CreateVersion7();

        await agent.SendTextAsync(agent.Envelope("coisa.nova.v1", new JsonObject(), correlation));

        var reply = (await agent.ReceiveAsync())!.Value;
        reply.GetProperty("type").GetString().Should().Be("command.result.v1");
        reply.GetProperty("source").GetString().Should().Be("api");
        reply.GetProperty("target").GetString().Should().Be($"agent:{app.Agent.Slug}");
        reply.GetProperty("correlationId").GetGuid().Should().Be(correlation);
        reply.GetProperty("body").GetProperty("ok").GetBoolean().Should().BeFalse();
        reply.GetProperty("body").GetProperty("error").GetProperty("code").GetString().Should().Be("invalid_message");
    }

    [Fact]
    public async Task ValidMessageNobodyHandles_IsDroppedWithoutCountingAsARefusal()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var state = new JsonObject { ["power"] = "on", ["volume"] = 25, ["app"] = null, ["connection"] = "hot" };

        // Mais do que o limite de recusas: um estado legítimo sem tratador não pode derrubar o agente.
        for (var i = 0; i < 10; i++)
        {
            await agent.SendTextAsync(agent.Envelope("tv.state.v1", state));
        }

        await agent.SendHelloAsync("3.0.0");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "3.0.0", "hello depois dos estados");
        agent.State.Should().Be(WebSocketState.Open);
    }

    [Fact]
    public async Task SixthRefusalInAMinute_ClosesWithPolicyViolation_ButFiveSpreadOverTimeDoNot()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var spread = await app.ConnectAsync();

        for (var i = 0; i < 5; i++)
        {
            await spread.SendTextAsync("lixo");
        }

        // A janela de 60 s esvazia: cinco recusas novas ainda cabem.
        await TransportApp.WaitUntilAsync(
            () => app.App.Logs.Lines.Count(l => l.Contains("recusada", StringComparison.Ordinal)) >= 5, "cinco recusas");
        app.App.Time.Advance(TimeSpan.FromSeconds(61));
        for (var i = 0; i < 5; i++)
        {
            await spread.SendTextAsync("lixo");
        }

        await spread.SendHelloAsync("4.0.0");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "4.0.0", "ainda viva");

        // A sexta dentro da mesma janela fecha.
        try
        {
            for (var i = 0; i < 6; i++)
            {
                await spread.SendTextAsync("lixo");
            }
        }
        catch (WebSocketException)
        {
            // O servidor pode fechar antes de o último envio sair.
        }

        var closed = await spread.WaitForCloseAsync();
        closed.Status.Should().Be(WebSocketCloseStatus.PolicyViolation);
    }

    [Fact]
    public async Task BinaryFrame_ClosesWith1003()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();

        await agent.SendBinaryAsync([1, 2, 3]);

        (await agent.WaitForCloseAsync()).Status.Should().Be(WebSocketCloseStatus.InvalidMessageType);
    }

    [Fact]
    public async Task MessageOver64Kb_ClosesWith1009()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();

        await agent.SendTextAsync(new string('a', 70 * 1024));

        (await agent.WaitForCloseAsync()).Status.Should().Be(WebSocketCloseStatus.MessageTooBig);
    }
}
