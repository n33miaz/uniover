using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity;

/// <summary>Escritas de conta reenviadas pelo cliente devem reaproveitar a primeira resposta, sem criar novo efeito.</summary>
[Collection(PostgresGroup.Name)]
public sealed class IdentityIdempotencyTests(PostgresFixture postgres)
{
    [Fact]
    public async Task SameKey_ReplaysTheProfileUpdate_AndRejectsAnotherBody()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var key = Guid.NewGuid();

        using var first = await app.SendAsync(
            HttpMethod.Patch, "/api/v1/identity/me", new { displayName = "Alice" }, owner.AccessToken, key);
        var firstBody = await first.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        using var replay = await app.SendAsync(
            HttpMethod.Patch, "/api/v1/identity/me", new { displayName = "Alice" }, owner.AccessToken, key);
        using var changed = await app.SendAsync(
            HttpMethod.Patch, "/api/v1/identity/me", new { displayName = "Bia" }, owner.AccessToken, key);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        replay.StatusCode.Should().Be(HttpStatusCode.OK);
        replay.Headers.GetValues("Idempotent-Replayed").Should().ContainSingle().Which.Should().Be("true");
        (await replay.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).Should().Be(firstBody);
        changed.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await PasskeyApp.JsonAsync(changed)).GetProperty("type").GetString().Should().EndWith("/idempotency-key-reused");
        await using var db = app.Db();
        (await db.Users.SingleAsync(TestContext.Current.CancellationToken)).DisplayName.Should().Be("Alice");
    }

    [Fact]
    public async Task GuestInvite_DoesNotStoreItsTokenInAnIdempotencyRecord()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);
        using var confirmation = await app.ConfirmAsync(owner, authenticator, StepUpActions.GuestInvite);
        confirmation.StatusCode.Should().Be(HttpStatusCode.OK);
        var key = Guid.NewGuid();

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/guest-invites", new { displayName = "Alice" }, owner.AccessToken, key);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await PasskeyApp.JsonAsync(response)).GetProperty("token").GetString().Should().NotBeNullOrEmpty();
        await using var db = app.Db();
        (await db.Set<IdempotencyRecord>().AnyAsync(record => record.Key == key, TestContext.Current.CancellationToken)).Should().BeFalse();
    }
}
