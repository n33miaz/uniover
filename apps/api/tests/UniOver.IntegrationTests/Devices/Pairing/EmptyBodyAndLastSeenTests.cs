using System.Net;
using System.Net.Http.Headers;
using System.Text;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Ports;

namespace UniOver.IntegrationTests.Devices.Pairing;

/// <summary>
/// Corpo opcional ausente executa a rota real (nunca o 404 do fallback de <c>/api</c>); corpo presente sem
/// <c>Content-Type</c> responde 415. Também cobre o <c>lastSeenAt</c> da lista de agentes.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class EmptyBodyAndLastSeenTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DevicesAppOptions NoStepUp = new() { RequireStepUp = false };

    [Fact]
    public async Task Revoke_WithoutBodyAndWithoutContentType_Executes()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (agentId, _, token, _) = await app.PairAsync(login);

        // SendAsync sem corpo: nenhum Content-Type e Content-Length zero, como um curl -X POST simples.
        using var response = await app.SendAsync(HttpMethod.Post, $"/api/v1/devices/agents/{agentId}/revoke", bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await app.ValidateAsync(token)).IsValid.Should().BeFalse();
        await using var db = app.Db();
        (await db.Agents.SingleAsync(Ct)).RevokedAt.Should().NotBeNull();
    }

    [Fact]
    public async Task Deny_WithABodyButWithoutContentType_Returns415_NeverTheApiFallback404()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/devices/pairing/deny")
        {
            Content = new ByteArrayContent(Encoding.UTF8.GetBytes($"{{\"userCode\":\"{started.UserCode}\"}}")),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);
        using var response = await app.Client.SendAsync(request, Ct);

        response.StatusCode.Should().Be(HttpStatusCode.UnsupportedMediaType);
    }

    [Fact]
    public async Task ListAgents_ExposesLastSeenAt_FromThePresenceWithoutTouchingTheDatabase()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (_, slug, _, _) = await app.PairAsync(login);

        using var before = await app.SendAsync(HttpMethod.Get, "/api/v1/devices/agents", bearer: login.AccessToken);
        (await DevicesApp.JsonAsync(before))[0].GetProperty("lastSeenAt").ValueKind
            .Should().Be(System.Text.Json.JsonValueKind.Null, "o agente ainda não se conectou");

        var seenAt = app.Time.GetUtcNow().AddMinutes(3);
        var presence = app.Services.GetRequiredService<IPresenceStore>();
        presence.MarkConnected(slug, app.Time.GetUtcNow());
        presence.Touch(slug, seenAt);

        using var after = await app.SendAsync(HttpMethod.Get, "/api/v1/devices/agents", bearer: login.AccessToken);
        (await DevicesApp.JsonAsync(after))[0].GetProperty("lastSeenAt").GetDateTimeOffset().Should().Be(seenAt);
    }
}
