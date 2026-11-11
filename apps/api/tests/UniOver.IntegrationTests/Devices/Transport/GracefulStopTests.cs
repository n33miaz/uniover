using System.Net.WebSockets;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Features.Agents;

namespace UniOver.IntegrationTests.Devices.Transport;

/// <summary>
/// O batimento do agente não é gravado no banco (ele dorme sem consulta): o último sinal de quem está conectado há horas é o da
/// conexão. No deploy a instância antiga recebe o SIGTERM; antes de tudo ela grava "visto agora" de cada agente conectado, para a
/// instância que assume nunca ver um sinal de dias atrás e abrir uma queda de quem acabou de reconectar.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class GracefulStopTests(PostgresFixture postgres)
{
    private static readonly string[] WithNotice = ["tv.remote", "transport.restart.v1"];
    private static readonly string[] WithoutNotice = ["tv.remote"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task TheStoppingInstance_StampsTheLastSignalOfEveryConnectedAgent(bool understandsTheRestartNotice)
    {
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { PresenceGraceSeconds = 150 });
        var connectedAt = app.App.Time.GetUtcNow();
        await using var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("1.2.3", understandsTheRestartNotice ? WithNotice : WithoutNotice);
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "1.2.3", "hello aceito");
        await TransportApp.WaitUntilAsync(async () => await LastSeenAsync(app) == connectedAt, "hello persistido");

        // Meia hora de batimento: a memória acompanha, o banco continua com o sinal da conexão.
        for (var i = 0; i < 6; i++)
        {
            app.App.Time.Advance(TimeSpan.FromMinutes(5));
            await agent.SendTextAsync(agent.Envelope("agent.keepalive.v1", new JsonObject()));
        }

        var now = app.App.Time.GetUtcNow();
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.LastMessageAt == now, "batimentos recebidos");
        (await LastSeenAsync(app)).Should().Be(connectedAt, "o batimento não vai ao banco");

        // O deploy manda o SIGTERM à instância antiga.
        await app.App.Services.GetRequiredService<AgentHub>().NotifyServerRestartAsync(Ct);

        (await LastSeenAsync(app)).Should().Be(now, "o último sinal fica fresco antes de a instância sair");
        if (understandsTheRestartNotice)
        {
            var closed = await agent.WaitForCloseAsync();
            closed.Status.Should().Be((WebSocketCloseStatus)4411);
        }
    }

    private static async Task<DateTimeOffset?> LastSeenAsync(TransportApp app)
    {
        await using var db = app.App.Db();
        return await db.AgentPresenceSnapshots.Where(x => x.AgentId == app.Agent.Id).Select(x => x.LastSeenAt).SingleOrDefaultAsync(Ct);
    }
}
