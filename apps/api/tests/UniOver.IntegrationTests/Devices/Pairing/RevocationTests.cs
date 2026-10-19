using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Messaging;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Features.Tokens;

namespace UniOver.IntegrationTests.Devices.Pairing;

[Collection(PostgresGroup.Name)]
public sealed class RevocationTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DevicesAppOptions NoStepUp = new() { RequireStepUp = false };

    [Fact]
    public async Task Revoke_InvalidatesTheToken_AtOnce_EvenWithItCached()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (agentId, _, token, _) = await app.PairAsync(login);

        (await app.ValidateAsync(token)).IsValid.Should().BeTrue();
        (await app.ValidateAsync(token)).IsValid.Should().BeTrue("a segunda validação vem do cache");

        using var revoke = await app.RevokeRawAsync(login, agentId, "perdi o PC");
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);

        var after = await app.ValidateAsync(token);
        after.IsValid.Should().BeFalse();
        after.Check.Should().Be(TokenCheck.Revoked);

        await using var db = app.Db();
        var agent = await db.Agents.SingleAsync(Ct);
        agent.RevokedAt.Should().Be(app.Time.GetUtcNow());
        agent.RevokedBy.Should().NotBeNull();
        agent.RevokeReason.Should().Be("perdi o PC");
    }

    [Fact]
    public async Task Revoke_TwiceIsIdempotent_OneEventAndOneAuditRow()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (agentId, _, _, _) = await app.PairAsync(login);

        using var first = await app.RevokeRawAsync(login, agentId);
        app.Time.Advance(TimeSpan.FromMinutes(1));
        using var second = await app.RevokeRawAsync(login, agentId);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Agents.SingleAsync(Ct)).RevokedAt.Should().Be(app.Time.GetUtcNow().AddMinutes(-1));
        (await db.PairingAudit.CountAsync(a => a.Event == "agent_revoked", Ct)).Should().Be(1);
        (await db.Set<OutboxMessage>().CountAsync(m => m.Type == "devices.agent-revoked.v1", Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Revoke_AnUnknownAgent_Returns404()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();

        using var response = await app.RevokeRawAsync(login, Guid.NewGuid());

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Revoke_WithAReasonOverTheLimit_Returns400()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (agentId, _, token, _) = await app.PairAsync(login);

        using var response = await app.RevokeRawAsync(login, agentId, new string('x', 101));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await app.ValidateAsync(token)).IsValid.Should().BeTrue();
    }

    [Fact]
    public async Task ListAgents_MarksTheRevokedOne()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (agentId, _, _, _) = await app.PairAsync(login);
        (await app.RevokeRawAsync(login, agentId)).Dispose();

        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/devices/agents", bearer: login.AccessToken);

        (await DevicesApp.JsonAsync(response))[0].GetProperty("revoked").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task RevokingBeforeTheTokenIsCollected_LeavesNothingToDeliver()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();
        var agent = await app.ApproveAsync(login, started.UserCode);
        (await app.RevokeRawAsync(login, agent.GetProperty("id").GetGuid())).Dispose();

        using var poll = await app.PollRawAsync(started.PairingId, started.DeviceCode);

        poll.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await poll.Content.ReadAsStringAsync(Ct)).Should().NotContain("uo_dev_");
        await using var db = app.Db();
        (await db.Agents.SingleAsync(Ct)).TokenHash.Should().BeNull();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("uo_dev_naoexiste")]
    [InlineData("Bearer abc")]
    public async Task Validator_WithGarbage_ReturnsUnknown(string? token)
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);

        (await app.ValidateAsync(token)).Check.Should().Be(TokenCheck.Unknown);
    }

    [Fact]
    public async Task Validator_WithAWellFormedTokenThatWasNeverIssued_ReturnsUnknown_AndTheTokenOfAnotherAgentWorksOnlyForIt()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (_, slugOne, tokenOne, _) = await app.PairAsync(login, "Um");
        var (_, slugTwo, tokenTwo, _) = await app.PairAsync(login, "Dois");

        (await app.ValidateAsync(tokenOne)).AgentId.Should().Be(slugOne);
        (await app.ValidateAsync(tokenTwo)).AgentId.Should().Be(slugTwo);
        var (forged, _) = Modules.Devices.Domain.DeviceSecrets.NewDeviceToken();
        (await app.ValidateAsync(forged)).Check.Should().Be(TokenCheck.Unknown);
    }

    [Fact]
    public async Task Validator_CacheExpiresAfterTheConfiguredTime()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { RequireStepUp = false, TokenCacheSeconds = 30 });
        var login = await app.LoginAsync();
        var (agentId, _, token, _) = await app.PairAsync(login);
        (await app.ValidateAsync(token)).IsValid.Should().BeTrue();

        // Revoga por fora do módulo (sem passar pela rota): só o fim da validade do cache faz a mudança valer.
        await using (var db = app.Db())
        {
            await db.Agents.Where(a => a.Id == agentId).ExecuteUpdateAsync(
                s => s.SetProperty(a => a.RevokedAt, app.Time.GetUtcNow()), Ct);
        }

        (await app.ValidateAsync(token)).IsValid.Should().BeTrue("ainda dentro dos 30 s");
        app.Time.Advance(TimeSpan.FromSeconds(31));
        (await app.ValidateAsync(token)).IsValid.Should().BeFalse();
    }

    [Fact]
    public async Task Events_PairedAndRevoked_AreDeliveredByTheOutbox_WithoutDeadLetters()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (agentId, slug, _, _) = await app.PairAsync(login);
        (await app.RevokeRawAsync(login, agentId)).Dispose();

        await app.WaitForOutboxAsync(2);

        await using var db = app.Db();
        var messages = await db.Set<OutboxMessage>().OrderBy(m => m.OccurredAt).ToListAsync(Ct);
        messages.Select(m => m.Type).Should().BeEquivalentTo(["devices.agent-paired.v1", "devices.agent-revoked.v1"]);
        messages.Should().OnlyContain(m => m.ProcessedAt != null);
        (await db.Set<DeadLetter>().CountAsync(Ct)).Should().Be(0);

        // O evento só carrega ids, slug e instante: nada de token nem de segredo.
        var paired = messages.Single(m => m.Type == "devices.agent-paired.v1").Payload;
        paired.Should().Contain(agentId.ToString()).And.Contain(slug).And.NotContain("uo_dev_").And.NotContainEquivalentOf("hash");
    }
}
