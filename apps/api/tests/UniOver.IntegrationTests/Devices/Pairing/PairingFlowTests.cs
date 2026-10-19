using System.Net;
using System.Security.Cryptography;
using System.Text;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Features.Tokens;

namespace UniOver.IntegrationTests.Devices.Pairing;

[Collection(PostgresGroup.Name)]
public sealed class PairingFlowTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DevicesAppOptions NoStepUp = new() { RequireStepUp = false };

    [Fact]
    public async Task FullFlow_StartPollPendingApprovePollApproved_TokenValidatesAndIsStoredOnlyAsAHash()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();

        var started = await app.StartAsync();
        using (var pending = await app.PollRawAsync(started.PairingId, started.DeviceCode))
        {
            pending.StatusCode.Should().Be(HttpStatusCode.OK);
            (await DevicesApp.JsonAsync(pending)).GetProperty("status").GetString().Should().Be("pending");
        }

        var agent = await app.ApproveAsync(login, started.UserCode);
        agent.GetProperty("slug").GetString().Should().Be("pc-casa");
        agent.GetProperty("name").GetString().Should().Be("PC Casa");

        using var approved = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        approved.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await DevicesApp.JsonAsync(approved);
        body.GetProperty("status").GetString().Should().Be("approved");
        body.GetProperty("agentId").GetString().Should().Be("pc-casa");
        var token = body.GetProperty("deviceToken").GetString()!;
        token.Should().StartWith("uo_dev_");

        var validation = await app.ValidateAsync(token);
        validation.Check.Should().Be(TokenCheck.Valid);
        validation.AgentId.Should().Be("pc-casa");
        validation.Id.Should().Be(agent.GetProperty("id").GetGuid());

        await using var db = app.Db();
        var row = await db.Agents.SingleAsync(Ct);
        row.TokenHash.Should().Equal(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
        row.PairedBy.Should().NotBeEmpty();
        var pairing = await db.Pairings.SingleAsync(Ct);
        pairing.ConsumedAt.Should().NotBeNull();
        pairing.ApprovedBy.Should().Be(row.PairedBy);
        pairing.AgentId.Should().Be(row.Id);
    }

    [Fact]
    public async Task Start_ReturnsTheDocumentedShape_AndNoSecretReachesTheDatabaseInPlainText()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);

        var started = await app.StartAsync();

        started.UserCode.Should().MatchRegex("^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$");
        started.DeviceCode.Should().HaveLength(43);
        started.Body.GetProperty("expiresIn").GetInt32().Should().Be(600);
        started.Body.GetProperty("interval").GetInt32().Should().Be(5);

        await using var db = app.Db();
        var row = await db.Pairings.SingleAsync(Ct);
        row.UserCode.Should().Be(started.UserCode.Replace("-", string.Empty, StringComparison.Ordinal));
        row.DeviceCodeHash.Should().HaveCount(32);
        Convert.ToBase64String(row.DeviceCodeHash).Should().NotContain(started.DeviceCode);
        row.ExpiresAt.Should().Be(app.Time.GetUtcNow().AddMinutes(10));
    }

    [Theory]
    [InlineData(null, "windows", "0.1.0")]
    [InlineData("", "windows", "0.1.0")]
    [InlineData("<script>", "windows", "0.1.0")]
    [InlineData("PC Casa", "", "0.1.0")]
    [InlineData("PC Casa", "win;dows", "0.1.0")]
    [InlineData("PC Casa", "windows", "")]
    [InlineData("PC Casa", "windows", "1.0 beta!")]
    public async Task Start_WithInvalidFields_Returns400(string? agentName, string platform, string agentVersion)
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/start", new { agentName, platform, agentVersion });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.Pairings.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Start_WithATooLongName_Returns400()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/start", new { agentName = new string('a', 61), platform = "windows", agentVersion = "1" });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Start_BeyondTheActiveLimit_Returns429WithRetryAfter_AndAnExpiredOneFreesASlot()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { RequireStepUp = false, MaxActive = 2 });

        await app.StartAsync("Um");
        await app.StartAsync("Dois");

        using var refused = await app.SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/start", new { agentName = "Tres", platform = "windows", agentVersion = "1" });
        refused.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        refused.Headers.RetryAfter.Should().NotBeNull();
        (await DevicesApp.JsonAsync(refused)).GetProperty("type").GetString().Should().EndWith("/too-many-pairings");

        app.Time.Advance(TimeSpan.FromMinutes(11));
        var again = await app.StartAsync("Tres");
        again.PairingId.Should().NotBeEmpty();
    }

    [Fact]
    public async Task Start_DeletesPairingsExpiredForMoreThanAnHour()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var old = await app.StartAsync("Antigo");

        app.Time.Advance(TimeSpan.FromHours(2));
        await app.StartAsync("Novo");

        await using var db = app.Db();
        var ids = await db.Pairings.Select(p => p.Id).ToListAsync(Ct);
        ids.Should().HaveCount(1).And.NotContain(old.PairingId);
    }

    [Fact]
    public async Task Poll_TwiceInARow_AnswersSlowDownWithALongerInterval_ThenPendingAfterTheInterval()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var started = await app.StartAsync();

        using var first = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        (await DevicesApp.JsonAsync(first)).GetProperty("status").GetString().Should().Be("pending");

        app.Time.Advance(TimeSpan.FromSeconds(2));
        using var fast = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        fast.StatusCode.Should().Be(HttpStatusCode.OK);
        var slow = await DevicesApp.JsonAsync(fast);
        slow.GetProperty("status").GetString().Should().Be("slow_down");
        slow.GetProperty("interval").GetInt32().Should().Be(10);

        // O poll apressado também conta: é preciso esperar o intervalo inteiro a partir dele.
        app.Time.Advance(TimeSpan.FromSeconds(5));
        using var calm = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        (await DevicesApp.JsonAsync(calm)).GetProperty("status").GetString().Should().Be("pending");
    }

    [Fact]
    public async Task Poll_WithAWrongDeviceCode_OrAnUnknownPairing_GivesTheSameAnswer()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var started = await app.StartAsync();
        var otherCode = (await app.StartAsync("Outro")).DeviceCode;

        using var wrongCode = await app.PollRawAsync(started.PairingId, otherCode);
        using var unknownId = await app.PollRawAsync(Guid.NewGuid(), started.DeviceCode);
        using var malformed = await app.PollRawAsync(started.PairingId, "nao-e-um-segredo");

        foreach (var response in new[] { wrongCode, unknownId, malformed })
        {
            response.StatusCode.Should().Be(HttpStatusCode.NotFound);
            (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pairing-not-found");
        }
    }

    [Fact]
    public async Task Poll_WithMissingFields_Returns400()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);

        using var response = await app.SendAsync(HttpMethod.Post, "/api/v1/devices/pairing/poll", new { });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task TheToken_AppearsOnlyOnce_TheSecondApprovedPollIsGone()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (_, _, token, started) = await app.PairAsync(login);

        using var again = await app.PollRawAsync(started.PairingId, started.DeviceCode);

        again.StatusCode.Should().Be(HttpStatusCode.Gone);
        var text = await again.Content.ReadAsStringAsync(Ct);
        text.Should().NotContain(token);
        (await DevicesApp.JsonAsync(again)).GetProperty("type").GetString().Should().EndWith("/pairing-consumed");
    }

    [Fact]
    public async Task TwoPollsAtTheSameTimeOnAnApprovedPairing_OnlyOneReceivesTheToken()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();
        await app.ApproveAsync(login, started.UserCode);

        var polls = await Task.WhenAll(Enumerable.Range(0, 6).Select(async _ =>
        {
            using var response = await app.PollRawAsync(started.PairingId, started.DeviceCode);
            return (response.StatusCode, Text: await response.Content.ReadAsStringAsync(Ct));
        }));

        polls.Count(p => p.Text.Contains("deviceToken", StringComparison.Ordinal)).Should().Be(1);
        polls.Where(p => !p.Text.Contains("deviceToken", StringComparison.Ordinal))
            .Should().OnlyContain(p => p.StatusCode == HttpStatusCode.Gone);
    }

    [Fact]
    public async Task ExpiredCode_PollIsGone_ApproveIsAGeneric404_AndTheExpiryIsAuditedOnce()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var started = await app.StartAsync();

        app.Time.Advance(TimeSpan.FromMinutes(10));
        var login = await app.LoginAsync();

        using var poll = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        poll.StatusCode.Should().Be(HttpStatusCode.Gone);
        (await DevicesApp.JsonAsync(poll)).GetProperty("type").GetString().Should().EndWith("/pairing-expired");
        (await app.PollRawAsync(started.PairingId, started.DeviceCode)).Dispose();

        using var approve = await app.ApproveRawAsync(login, started.UserCode);
        approve.StatusCode.Should().Be(HttpStatusCode.NotFound);

        await using var db = app.Db();
        (await db.PairingAudit.CountAsync(a => a.Event == "expired", Ct)).Should().Be(1);
        (await db.Agents.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task ReusedCode_SecondApproveIsA404_AndNoSecondAgentIsCreated()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();
        await app.ApproveAsync(login, started.UserCode);

        using var second = await app.ApproveRawAsync(login, started.UserCode, "Outro");

        second.StatusCode.Should().Be(HttpStatusCode.NotFound);
        await using var db = app.Db();
        (await db.Agents.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ApproveWithAnUnknownOrMalformedCode_IsTheSame404()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();

        foreach (var code in new[] { "BCDF-GHJK", "xx", "BCDF-GHJA" })
        {
            using var response = await app.ApproveRawAsync(login, code);
            response.StatusCode.Should().Be(HttpStatusCode.NotFound);
            (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/pairing-not-found");
        }
    }

    [Fact]
    public async Task ApproveAcceptsTheCodeWithoutHyphenAndInLowercase()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();

        var typed = started.UserCode.Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();

        (await app.ApproveAsync(login, typed)).GetProperty("slug").GetString().Should().Be("pc-casa");
    }

    [Fact]
    public async Task Approve_WithAFinalName_UsesItAndDerivesTheSlug_CollisionsGetASuffix()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();

        var first = await app.ApproveAsync(login, (await app.StartAsync("Pedido A")).UserCode, "Sala de Estar");
        var second = await app.ApproveAsync(login, (await app.StartAsync("Pedido B")).UserCode, "Sala de Estar");
        var third = await app.ApproveAsync(login, (await app.StartAsync("Pedido C")).UserCode, "sala-de-estar");

        first.GetProperty("slug").GetString().Should().Be("sala-de-estar");
        first.GetProperty("name").GetString().Should().Be("Sala de Estar");
        second.GetProperty("slug").GetString().Should().Be("sala-de-estar-2");
        third.GetProperty("slug").GetString().Should().Be("sala-de-estar-3");
    }

    [Fact]
    public async Task Approve_WithAnInvalidName_Returns400()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();

        using var response = await app.ApproveRawAsync(login, started.UserCode, "<b>x</b>");

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Deny_MakesThePollForbidden_AndTheCodeCannotBeApprovedAfterwards()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();

        using var deny = await app.DenyRawAsync(login, started.UserCode);
        deny.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var poll = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        poll.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await DevicesApp.JsonAsync(poll)).GetProperty("type").GetString().Should().EndWith("/pairing-denied");

        using var approve = await app.ApproveRawAsync(login, started.UserCode);
        approve.StatusCode.Should().Be(HttpStatusCode.NotFound);
        using var denyAgain = await app.DenyRawAsync(login, started.UserCode);
        denyAgain.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Deny_AnApprovedCode_IsA404()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();
        await app.ApproveAsync(login, started.UserCode);

        using var deny = await app.DenyRawAsync(login, started.UserCode);

        deny.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task AuthenticatedRoutes_WithoutLogin_Return401()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var started = await app.StartAsync();

        using var approve = await app.ApproveRawAsync(null, started.UserCode);
        using var deny = await app.DenyRawAsync(null, started.UserCode);
        using var list = await app.SendAsync(HttpMethod.Get, "/api/v1/devices/agents");
        using var revoke = await app.RevokeRawAsync(null, Guid.NewGuid());

        approve.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        deny.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        list.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        revoke.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await using var db = app.Db();
        (await db.Agents.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task ListAgents_ShowsIdSlugNamePlatformCreatedAtAndRevoked()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var (id, _, _, _) = await app.PairAsync(login);

        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/devices/agents", bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var list = await DevicesApp.JsonAsync(response);
        list.GetArrayLength().Should().Be(1);
        var item = list[0];
        item.GetProperty("id").GetGuid().Should().Be(id);
        item.GetProperty("slug").GetString().Should().Be("pc-casa");
        item.GetProperty("name").GetString().Should().Be("PC Casa");
        item.GetProperty("platform").GetString().Should().Be("windows");
        item.GetProperty("createdAt").GetDateTimeOffset().Should().Be(app.Time.GetUtcNow());
        item.GetProperty("revoked").GetBoolean().Should().BeFalse();
        item.TryGetProperty("tokenHash", out _).Should().BeFalse();
    }
}
