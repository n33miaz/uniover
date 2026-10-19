using System.Net;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Domain;

namespace UniOver.IntegrationTests.Devices.Transport;

[Collection(PostgresGroup.Name)]
public sealed class HandshakeTests(PostgresFixture postgres)
{
    [Fact]
    public async Task ValidToken_Connects_AndPresenceAppearsThenGoesOffline()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        await using (var agent = await app.ConnectAsync())
        {
            await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == true, "presença conectada");
            app.Presence.Get(app.Agent.Slug)!.ConnectedSince.Should().NotBeNull();
        }

        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "presença desconectada");
    }

    [Fact]
    public async Task WithoutToken_WrongToken_AndUserJwt_AreRefusedBeforeTheUpgrade_With401()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var unknown = DeviceSecrets.NewDeviceToken().Token;

        (await app.HandshakeStatusAsync(app.Agent.Slug, bearer: null)).Should().Be(HttpStatusCode.Unauthorized);
        (await app.HandshakeStatusAsync(app.Agent.Slug, unknown)).Should().Be(HttpStatusCode.Unauthorized);
        (await app.HandshakeStatusAsync(app.Agent.Slug, "lixo")).Should().Be(HttpStatusCode.Unauthorized);

        // O JWT do dono não abre o canal do agente: só o token de dispositivo vale nesta rota.
        (await app.HandshakeStatusAsync(app.Agent.Slug, app.Login.AccessToken)).Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task TokenInTheQueryString_IsNeverAccepted()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        var status = await app.HandshakeStatusAsync(
            app.Agent.Slug, bearer: null, query: $"?access_token={app.Agent.Token}&token={app.Agent.Token}");

        status.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task RevokedToken_IsRefusedWith403_AndAnotherAgentsSlug_IsRefusedWith403()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var other = await app.PairAnotherAsync("Outro PC");

        // O token é válido, mas o agentId da rota é de outro agente: só se abre o próprio canal.
        (await app.HandshakeStatusAsync(other.Slug, app.Agent.Token)).Should().Be(HttpStatusCode.Forbidden);
        (await app.HandshakeStatusAsync("nao-existe", app.Agent.Token)).Should().Be(HttpStatusCode.Forbidden);

        using var revoke = await app.App.RevokeRawAsync(app.Login, app.Agent.Id, "teste");
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        (await app.HandshakeStatusAsync(app.Agent.Slug, app.Agent.Token)).Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task ValidTokenWithoutUpgrade_Returns400_NotAnAcceptedConnection()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        (await app.HandshakeStatusAsync(app.Agent.Slug, app.Agent.Token)).Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task TheDeviceToken_NeverAppearsInTheLogs()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var unknown = DeviceSecrets.NewDeviceToken().Token;

        await using (var agent = await app.ConnectAsync())
        {
            await agent.SendHelloAsync();
            await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion is not null, "hello");
        }

        await app.HandshakeStatusAsync(app.Agent.Slug, unknown);
        await app.HandshakeStatusAsync(app.Agent.Slug, bearer: null, query: $"?token={unknown}");

        var logs = string.Join('\n', app.App.Logs.Lines);
        logs.Should().NotContain(app.Agent.Token);
        logs.Should().NotContain(unknown);
        logs.Should().NotContain(app.Agent.Token[DeviceSecrets.TokenPrefix.Length..]);
    }
}
