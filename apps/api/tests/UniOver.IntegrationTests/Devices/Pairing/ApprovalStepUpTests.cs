using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Devices.Pairing;

/// <summary>Aprovar pareamento é ação perigosa (passkey); recusar e revogar não são.</summary>
[Collection(PostgresGroup.Name)]
public sealed class ApprovalStepUpTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Approve_WithoutLogin_Returns401_NotAStepUpError()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var started = await app.StartAsync();

        using var response = await app.ApproveRawAsync(null, started.UserCode);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Approve_WithLoginButNoStepUp_Returns403StepUpRequired_AndCreatesNothing()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();

        using var response = await app.ApproveRawAsync(login, started.UserCode);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var problem = await DevicesApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/step-up-required");
        problem.GetProperty("code").GetString().Should().Be("step_up_required");
        problem.GetProperty("action").GetString().Should().Be("devices.pair-approve");

        await using var db = app.Db();
        (await db.Agents.CountAsync(Ct)).Should().Be(0);
        (await db.Pairings.SingleAsync(Ct)).ApprovedAt.Should().BeNull();
    }

    [Fact]
    public async Task Approve_AfterConfirmingWithThePasskey_Returns200()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        using var authenticator = new VirtualAuthenticator();
        var login = await app.LoginAsync();
        await app.RegisterPasskeyAsync(login, authenticator);
        var started = await app.StartAsync();

        await app.ConfirmApproveAsync(login, authenticator);
        using var response = await app.ApproveRawAsync(login, started.UserCode);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await DevicesApp.JsonAsync(response)).GetProperty("slug").GetString().Should().Be("pc-casa");
    }

    [Fact]
    public async Task Approve_WhenTheConfirmationExpired_AsksAgain()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        using var authenticator = new VirtualAuthenticator();
        var login = await app.LoginAsync();
        await app.RegisterPasskeyAsync(login, authenticator);
        await app.ConfirmApproveAsync(login, authenticator);

        // A confirmação vale 5 min; o pareamento (10 min) ainda está aberto.
        app.Time.Advance(TimeSpan.FromMinutes(6));
        var started = await app.StartAsync();

        // O JWT da mesma sessão ainda vale (10 min); só a confirmação (5 min) venceu.
        using var response = await app.ApproveRawAsync(login, started.UserCode);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/step-up-required");
    }

    [Fact]
    public async Task Approve_WithRequireStepUpOffInDevelopment_NeedsOnlyTheLogin()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { RequireStepUp = false });
        var login = await app.LoginAsync();
        var started = await app.StartAsync();

        using var response = await app.ApproveRawAsync(login, started.UserCode);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Approve_WithRequireStepUpOffOutsideDevelopment_StillAsksForThePasskey()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { Environment = "Production", RequireStepUp = false });
        var login = await app.LoginAsync();
        var started = await app.StartAsync();

        using var response = await app.ApproveRawAsync(login, started.UserCode);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/step-up-required");
    }

    [Fact]
    public async Task Deny_NeedsNoPasskey_EvenWithTheStepUpRequirementOn()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();

        using var deny = await app.DenyRawAsync(login, started.UserCode);

        deny.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Revoke_NeedsNoPasskeyBeyondTheOneUsedToApprove()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        using var authenticator = new VirtualAuthenticator();
        var login = await app.LoginAsync();
        await app.RegisterPasskeyAsync(login, authenticator);
        var started = await app.StartAsync();
        await app.ConfirmApproveAsync(login, authenticator);
        var agent = await app.ApproveAsync(login, started.UserCode);

        // Uma sessão nova, sem nenhuma confirmação: revogar só pede login.
        var other = await app.LoginAsync();
        using var revoke = await app.RevokeRawAsync(other, agent.GetProperty("id").GetGuid());

        revoke.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
