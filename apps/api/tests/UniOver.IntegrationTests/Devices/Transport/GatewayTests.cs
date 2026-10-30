using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.IntegrationTests.Devices.Transport;

[Collection(PostgresGroup.Name)]
public sealed class GatewayTests(PostgresFixture postgres)
{
    private static OutboundMessage Key(string key = "VOLUME_UP") =>
        new("tv.key.v1", JsonSerializer.SerializeToElement(TransportApp.TvKeyBody(key)));

    private static JsonObject Result(bool ok, string? code = null) => ok
        ? new JsonObject { ["ok"] = true }
        : new JsonObject { ["ok"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = "falhou" } };

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, TestContext.Current.CancellationToken);

    [Fact]
    public async Task Request_WithACorrelatedReply_ReturnsTheResult()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == true, "conectado");

        var request = app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        var command = (await agent.ReceiveAsync())!.Value;
        command.GetProperty("type").GetString().Should().Be("tv.key.v1");
        command.GetProperty("source").GetString().Should().Be("api");
        command.GetProperty("target").GetString().Should().Be($"agent:{app.Agent.Slug}");
        command.GetProperty("body").GetProperty("key").GetString().Should().Be("VOLUME_UP");

        // O correlationId da resposta aponta o id do comando.
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Result(true), command.GetProperty("id").GetGuid()));

        var reply = await Within(request);
        reply.IsSuccess.Should().BeTrue();
        reply.Value.Ok.Should().BeTrue();
        reply.Value.CorrelationId.Should().Be(command.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Request_WithAFailedResult_CarriesTheAgentError()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == true, "conectado");

        var request = app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        var command = (await agent.ReceiveAsync())!.Value;
        await agent.SendTextAsync(agent.Envelope("command.result.v1", Result(false, "TV_UNREACHABLE"), command.GetProperty("id").GetGuid()));

        var reply = (await Within(request)).Value;
        reply.Ok.Should().BeFalse();
        reply.Error!.Code.Should().Be("TV_UNREACHABLE");
    }

    [Fact]
    public async Task Request_ToAnOfflineAgent_FailsAfterTheReconnectGrace()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        var request = app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await Task.Delay(25, TestContext.Current.CancellationToken);
        request.IsCompleted.Should().BeFalse("a janela absorve uma reconexão curta");
        app.App.Time.Advance(TimeSpan.FromSeconds(26));
        var result = await Within(request);

        result.IsFailure.Should().BeTrue();
        result.Error.Code.Should().Be("agent_offline");

        var send = app.Gateway.SendAsync(app.Agent.Slug, Key(), TestContext.Current.CancellationToken);
        await Task.Delay(25, TestContext.Current.CancellationToken);
        app.App.Time.Advance(TimeSpan.FromSeconds(26));
        (await Within(send)).Error.Code.Should().Be("agent_offline");
    }

    [Fact]
    public async Task Send_WaitsForTheAgentToReconnectInsideTheGrace()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        var send = app.Gateway.SendAsync(app.Agent.Slug, Key(), TestContext.Current.CancellationToken);
        await Task.Delay(25, TestContext.Current.CancellationToken);
        send.IsCompleted.Should().BeFalse("o gateway ainda aguarda a reconexão");

        await using var agent = await app.ConnectAsync();
        var command = (await agent.ReceiveAsync())!.Value;
        command.GetProperty("type").GetString().Should().Be("tv.key.v1");

        (await Within(send)).IsSuccess.Should().BeTrue();
    }

    [Fact]
    public async Task Request_WithoutAReplyInTime_TimesOut_AndALateReplyIsDiscarded()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == true, "conectado");

        var request = app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        var command = (await agent.ReceiveAsync())!.Value;

        // O temporizador nasce logo depois do envio; avança até o prazo estourar.
        while (!request.IsCompleted)
        {
            app.App.Time.Advance(TimeSpan.FromSeconds(6));
            await Task.Delay(25, TestContext.Current.CancellationToken);
        }

        var result = await request;
        result.IsFailure.Should().BeTrue();
        result.Error.Code.Should().Be("agent_timeout");

        await agent.SendTextAsync(agent.Envelope("command.result.v1", Result(true), command.GetProperty("id").GetGuid()));
        await TransportApp.WaitUntilAsync(
            () => app.App.Logs.Lines.Any(l => l.Contains("descartada", StringComparison.Ordinal) && l.Contains("ninguém espera", StringComparison.Ordinal)),
            "resposta tardia registrada");
    }

    [Fact]
    public async Task Request_IsNotCompletedByAnotherAgentsReply()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var other = await app.PairAnotherAsync("Outro PC");
        await using var agent = await app.ConnectAsync();
        await using var intruder = await FakeAgent.ConnectAsync(app.Server, other.Slug, other.Token);
        await TransportApp.WaitUntilAsync(
            () => app.Presence.Get(app.Agent.Slug)?.Connected == true && app.Presence.Get(other.Slug)?.Connected == true, "dois conectados");

        var request = app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        var command = (await agent.ReceiveAsync())!.Value;
        var commandId = command.GetProperty("id").GetGuid();

        await intruder.SendTextAsync(intruder.Envelope("command.result.v1", Result(false, "FORGED"), commandId));
        await TransportApp.WaitUntilAsync(
            () => app.App.Logs.Lines.Any(l => l.Contains("descartada", StringComparison.Ordinal)), "resposta de outro agente descartada");
        request.IsCompleted.Should().BeFalse();

        await agent.SendTextAsync(agent.Envelope("command.result.v1", Result(true), commandId));
        (await Within(request)).Value.Ok.Should().BeTrue();
    }

    [Fact]
    public async Task Request_WhenTheAgentDisconnectsWhileWaiting_FailsAsOffline()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var agent = await app.ConnectAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == true, "conectado");

        var request = app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await agent.ReceiveAsync();
        await agent.DisposeAsync();

        var result = await Within(request);
        result.Error.Code.Should().Be("agent_offline");
    }

    [Fact]
    public async Task OutboundMessagesOutsideTheContract_AreRefusedAndNeverDelivered()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == true, "conectado");

        var unknownType = await app.Gateway.SendAsync(
            app.Agent.Slug, new OutboundMessage("coisa.nova.v1", JsonSerializer.SerializeToElement(new JsonObject())),
            TestContext.Current.CancellationToken);
        var badBody = await app.Gateway.RequestAsync(
            app.Agent.Slug, Key("NAO_EXISTE"), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        unknownType.Error.Code.Should().Be("invalid_message");
        badBody.Error.Code.Should().Be("invalid_message");

        // Nada foi enviado: a próxima mensagem que o agente lê é a deste comando válido.
        _ = app.Gateway.SendAsync(app.Agent.Slug, Key("MUTE"), TestContext.Current.CancellationToken);
        (await agent.ReceiveAsync())!.Value.GetProperty("body").GetProperty("key").GetString().Should().Be("MUTE");
    }
}
