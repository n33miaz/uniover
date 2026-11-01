using System.Data.Common;
using System.Net;
using System.Net.Http.Headers;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore.Diagnostics;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Domain;

namespace UniOver.IntegrationTests.Devices.Transport;

/// <summary>
/// Token de agente inexistente ou revogado custa uma consulta ao banco por tentativa. Depois do teto de falhas por IP o
/// banco deixa de ser consultado (429), sem derrubar o agente certo, que passa pelo cache.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TokenFailureLimitTests(PostgresFixture postgres)
{
    private const int Limit = 3;

    [Fact]
    public async Task AfterTheLimit_InvalidTokensAreRefusedWith429_WithoutQueryingTheDatabase()
    {
        var counter = new AgentLookupCounter();
        await using var app = await StartAsync(postgres, counter);

        for (var i = 0; i < Limit; i++)
        {
            (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.Unauthorized);
        }

        var before = counter.Lookups;
        var (status, retryAfter) = await HandshakeAsync(app, DeviceSecrets.NewDeviceToken().Token);

        status.Should().Be(HttpStatusCode.TooManyRequests);
        retryAfter.Should().BeGreaterThan(0);
        counter.Lookups.Should().Be(before, "a origem bloqueada não pode acordar o banco com token novo");
    }

    [Fact]
    public async Task ARevokedTokenCountsAsAFailureToo()
    {
        var counter = new AgentLookupCounter();
        await using var app = await StartAsync(postgres, counter);
        using var revoke = await app.App.RevokeRawAsync(app.Login, app.Agent.Id, "teste");
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);

        for (var i = 0; i < Limit; i++)
        {
            (await app.HandshakeStatusAsync(app.Agent.Slug, app.Agent.Token)).Should().Be(HttpStatusCode.Forbidden);
        }

        (await app.HandshakeStatusAsync(app.Agent.Slug, app.Agent.Token)).Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task TheRightAgentKeepsConnecting_WhileItsTokenIsInTheCache_EvenFromABlockedOrigin()
    {
        var counter = new AgentLookupCounter();
        await using var app = await StartAsync(postgres, counter);

        // Primeira validação do token certo: vai ao banco e entra no cache (sem upgrade a abertura responde 400).
        (await app.HandshakeStatusAsync(app.Agent.Slug, app.Agent.Token)).Should().Be(HttpStatusCode.BadRequest);
        for (var i = 0; i < Limit; i++)
        {
            await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token);
        }

        (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.TooManyRequests);
        (await app.HandshakeStatusAsync(app.Agent.Slug, app.Agent.Token)).Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task WhenTheWindowPasses_TheOriginIsServedAgain()
    {
        var counter = new AgentLookupCounter();
        await using var app = await StartAsync(postgres, counter);
        for (var i = 0; i < Limit; i++)
        {
            await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token);
        }

        (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.TooManyRequests);

        app.App.Time.Advance(TimeSpan.FromSeconds(61));

        (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.Unauthorized);
    }

    private static Task<TransportApp> StartAsync(PostgresFixture postgres, AgentLookupCounter counter) =>
        TransportApp.StartAsync(postgres, new DevicesAppOptions { TokenFailureLimit = Limit, CommandInterceptor = counter });

    private static async Task<(HttpStatusCode Status, int RetryAfter)> HandshakeAsync(TransportApp app, string bearer)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/devices/agents/{app.Agent.Slug}/ws");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        using var response = await app.App.Client.SendAsync(request, TestContext.Current.CancellationToken);
        var retryAfter = response.Headers.RetryAfter?.Delta is { } delta ? (int)delta.TotalSeconds : 0;
        return (response.StatusCode, retryAfter);
    }

    /// <summary>Conta as leituras da tabela de agentes (cada validação de token fora do cache faz uma).</summary>
    private sealed class AgentLookupCounter : DbCommandInterceptor
    {
        private int _lookups;

        public int Lookups => Volatile.Read(ref _lookups);

        public override ValueTask<DbDataReader> ReaderExecutedAsync(
            DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("token_hash", StringComparison.OrdinalIgnoreCase)
                && command.CommandText.Contains("agents", StringComparison.OrdinalIgnoreCase))
            {
                Interlocked.Increment(ref _lookups);
            }

            return base.ReaderExecutedAsync(command, eventData, result, cancellationToken);
        }
    }
}
