using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Devices.Pairing;

/// <summary>Aprovar um aparelho é seguro contra a repetição que a fila offline ou um toque duplo pode enviar.</summary>
[Collection(PostgresGroup.Name)]
public sealed class DevicesIdempotencyTests(PostgresFixture postgres)
{
    [Fact]
    public async Task SameKey_ReplaysTheApproval_AndRejectsAnotherBody()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { RequireStepUp = false });
        var owner = await app.LoginAsync();
        var started = await app.StartAsync();
        var key = Guid.NewGuid();

        using var first = await app.SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/approve", new { userCode = started.UserCode, name = "PC da sala" }, owner.AccessToken,
            idempotencyKey: key);
        var firstBody = await first.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        using var replay = await app.SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/approve", new { userCode = started.UserCode, name = "PC da sala" }, owner.AccessToken,
            idempotencyKey: key);
        using var changed = await app.SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/approve", new { userCode = started.UserCode, name = "PC do quarto" }, owner.AccessToken,
            idempotencyKey: key);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        replay.StatusCode.Should().Be(HttpStatusCode.OK);
        replay.Headers.GetValues("Idempotent-Replayed").Should().ContainSingle().Which.Should().Be("true");
        (await replay.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).Should().Be(firstBody);
        changed.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await IdentityApp.JsonAsync(changed)).GetProperty("type").GetString().Should().EndWith("/idempotency-key-reused");
        await using var db = app.Db();
        (await db.Agents.CountAsync(TestContext.Current.CancellationToken)).Should().Be(1);
    }
}
