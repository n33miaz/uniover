using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Tv;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Devices.Pairing;

/// <summary>
/// O convidado com a permissão da TV aprova o pareamento do PC dele para a PRÓPRIA TV: com a senha reconfirmada, uma TV só
/// dele, nunca a padrão, com teto de computadores e tudo na trilha. O dono continua mandando em tudo.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class GuestSelfApprovalTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<string> ReadTypeAsync(HttpResponseMessage response) =>
        (await DevicesApp.JsonAsync(response)).GetProperty("type").GetString()!;

    [Fact]
    public async Task Guest_WithTheTvPermissionAndAFreshPassword_ApprovesAndGetsHisOwnTv()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();
        await app.ConfirmWithPasswordAsync(guest);
        var started = await app.StartAsync("PC do Raphael");

        using var response = await app.ApproveOwnRawAsync(guest.Login, new { userCode = started.UserCode, tvName = "TV de Raphael" });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var slug = (await DevicesApp.JsonAsync(response)).GetProperty("slug").GetString();

        // A TV nasce só dele: sem outras pessoas e, mesmo sendo a primeira de todas, sem virar a padrão.
        await using var tv = TvApp.CreateContext(app.Database.OwnerConnection);
        var row = await tv.Tvs.SingleAsync(Ct);
        row.AgentSlug.Should().Be(slug);
        row.Name.Should().Be("TV de Raphael");
        row.IsDefault.Should().BeFalse();
        (await tv.TvMembers.Where(m => m.TvId == row.Id).Select(m => m.UserId).ToListAsync(Ct)).Should().Equal(guest.UserId);

        // O agente é dele e a trilha diz quem aprovou, de onde e qual aparelho.
        await using var devices = app.Db();
        (await devices.Agents.SingleAsync(Ct)).PairedBy.Should().Be(guest.UserId);
        var approved = await devices.PairingAudit.SingleAsync(a => a.Event == PairingEvents.Approved, Ct);
        approved.UserId.Should().Be(guest.UserId);
        approved.AgentId.Should().NotBeNull();

        // O agente recolhe o token como sempre.
        using var poll = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        poll.StatusCode.Should().Be(HttpStatusCode.OK);
        (await DevicesApp.JsonAsync(poll)).GetProperty("status").GetString().Should().Be("approved");
    }

    [Fact]
    public async Task TheConfirmationIsAudited_InTheIdentityTrail_WithoutThePassword()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();

        await app.ConfirmWithPasswordAsync(guest);

        await using var identity = IdentityApp.CreateContext(app.Database.OwnerConnection);
        var row = await identity.LoginAudit.SingleAsync(a => a.Event == AuditEvents.StepUpSucceeded, Ct);
        row.UserId.Should().Be(guest.UserId);
        row.Detail.Should().Be("devices.pair-self|password");
        row.Detail.Should().NotContain(guest.Password);
    }

    [Fact]
    public async Task Guest_WithoutTheConfirmation_Gets403StepUpRequired_AndNothingIsCreated()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();
        var started = await app.StartAsync();

        using var response = await app.ApproveOwnRawAsync(guest.Login, new { userCode = started.UserCode });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var problem = await DevicesApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/step-up-required");
        problem.GetProperty("action").GetString().Should().Be(DevicesApp.PairSelfAction);
        await using var db = app.Db();
        (await db.Agents.CountAsync(Ct)).Should().Be(0);
        (await db.Pairings.SingleAsync(Ct)).ApprovedAt.Should().BeNull();
    }

    [Fact]
    public async Task Guest_WhenTheConfirmationExpired_AsksAgain()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();
        await app.ConfirmWithPasswordAsync(guest);

        // A confirmação vale 5 min; o pareamento (10 min) e o JWT (10 min) ainda valem.
        app.Time.Advance(TimeSpan.FromMinutes(6));
        var started = await app.StartAsync();

        using var response = await app.ApproveOwnRawAsync(guest.Login, new { userCode = started.UserCode });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await ReadTypeAsync(response)).Should().EndWith("/step-up-required");
    }

    [Fact]
    public async Task TheConfirmationOfOneSession_DoesNotValidAnotherSessionOfTheSameGuest()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();
        await app.ConfirmWithPasswordAsync(guest);
        var otherSession = await app.LoginAsync(guest);
        var started = await app.StartAsync();

        using var response = await app.ApproveOwnRawAsync(otherSession, new { userCode = started.UserCode });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await ReadTypeAsync(response)).Should().EndWith("/step-up-required");
    }

    [Fact]
    public async Task Guest_WithoutTheTvPermission_Gets403_EvenWithAFreshPassword()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync(["module:training"]);
        await app.ConfirmWithPasswordAsync(guest);
        var started = await app.StartAsync();

        using var response = await app.ApproveOwnRawAsync(guest.Login, new { userCode = started.UserCode });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.Agents.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Guest_CannotAddOtherPeopleOrChooseTheirTv_TheBodyOnlyCarriesTheCode()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();
        await app.ConfirmWithPasswordAsync(guest);
        var started = await app.StartAsync();
        var stranger = Guid.NewGuid();

        // Campos que a rota do administrador aceita são ignorados aqui: a TV sai só com ele.
        using var response = await app.ApproveOwnRawAsync(
            guest.Login, new { userCode = started.UserCode, tvMemberIds = new[] { stranger, Guid.NewGuid() }, isDefault = true });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var tv = TvApp.CreateContext(app.Database.OwnerConnection);
        var row = await tv.Tvs.SingleAsync(Ct);
        row.IsDefault.Should().BeFalse();
        (await tv.TvMembers.Select(m => m.UserId).ToListAsync(Ct)).Should().Equal(guest.UserId);
    }

    [Fact]
    public async Task Guest_NeverTakesTheDefaultTv_WhenTheOwnerAlreadyHasOne()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { RequireStepUp = false });
        var owner = await app.LoginAsync();
        await app.ApproveAsync(owner, (await app.StartAsync("PC Casa")).UserCode);
        var guest = await app.NewGuestAsync();
        await app.ConfirmWithPasswordAsync(guest);
        var started = await app.StartAsync("PC Raphael");

        using var response = await app.ApproveOwnRawAsync(guest.Login, new { userCode = started.UserCode });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var tv = TvApp.CreateContext(app.Database.OwnerConnection);
        var tvs = await tv.Tvs.OrderBy(t => t.CreatedAt).ToListAsync(Ct);
        tvs.Should().HaveCount(2);
        tvs[0].IsDefault.Should().BeTrue();
        tvs[1].IsDefault.Should().BeFalse();
    }

    [Fact]
    public async Task Guest_CannotUseTheAdministratorRoute()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();
        await app.ConfirmWithPasswordAsync(guest);
        var started = await app.StartAsync();

        using var response = await app.ApproveRawAsync(guest.Login, started.UserCode);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.Agents.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Owner_CannotUseTheGuestRoute()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var started = await app.StartAsync();

        using var response = await app.ApproveOwnRawAsync(owner, new { userCode = started.UserCode });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.Agents.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Guest_HasALimitOfActiveComputers_AndRevokingOneFreesASpot()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();
        await app.ConfirmWithPasswordAsync(guest);
        Guid firstAgent = default;
        for (var n = 1; n <= 2; n++)
        {
            var pairing = await app.StartAsync($"PC {n}");
            using var ok = await app.ApproveOwnRawAsync(guest.Login, new { userCode = pairing.UserCode });
            ok.StatusCode.Should().Be(HttpStatusCode.OK);
            if (n == 1)
            {
                firstAgent = (await DevicesApp.JsonAsync(ok)).GetProperty("id").GetGuid();
            }
        }

        var third = await app.StartAsync("PC 3");
        using var refused = await app.ApproveOwnRawAsync(guest.Login, new { userCode = third.UserCode });

        refused.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await ReadTypeAsync(refused)).Should().EndWith("/guest-agent-limit");
        await using (var db = app.Db())
        {
            (await db.Agents.CountAsync(Ct)).Should().Be(2);
            (await db.Pairings.SingleAsync(p => p.UserCode == third.UserCode.Replace("-", string.Empty), Ct)).ApprovedAt.Should().BeNull();
        }

        // Só o administrador libera: revoga um e o convidado volta a poder parear.
        var owner = await app.LoginAsync();
        using var revoke = await app.RevokeRawAsync(owner, firstAgent);
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        using var allowed = await app.ApproveOwnRawAsync(guest.Login, new { userCode = third.UserCode });
        allowed.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task TheLimitIsPerGuest_AndTheOwnerHasNone()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { RequireStepUp = false });
        var raphael = await app.NewGuestAsync(label: "Raphael");
        var bia = await app.NewGuestAsync(label: "Bia");
        await app.ConfirmWithPasswordAsync(raphael);
        await app.ConfirmWithPasswordAsync(bia);
        for (var n = 1; n <= 2; n++)
        {
            using var ok = await app.ApproveOwnRawAsync(raphael.Login, new { userCode = (await app.StartAsync($"R {n}")).UserCode });
            ok.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var biaOk = await app.ApproveOwnRawAsync(bia.Login, new { userCode = (await app.StartAsync("B 1")).UserCode });
        biaOk.StatusCode.Should().Be(HttpStatusCode.OK);

        var owner = await app.LoginAsync();
        for (var n = 1; n <= 3; n++)
        {
            (await app.ApproveWithTvRawAsync(owner, (await app.StartAsync($"D {n}")).UserCode, [])).StatusCode
                .Should().Be(HttpStatusCode.OK);
        }
    }

    [Fact]
    public async Task Owner_SeesTheGuestsComputer_AndCanRevokeIt_AndTheGuestCannotListAgents()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();
        await app.ConfirmWithPasswordAsync(guest);
        var started = await app.StartAsync("PC do Raphael");
        using var approved = await app.ApproveOwnRawAsync(guest.Login, new { userCode = started.UserCode });
        var agentId = (await DevicesApp.JsonAsync(approved)).GetProperty("id").GetGuid();
        var owner = await app.LoginAsync();

        using var list = await app.ListAgentsRawAsync(owner);
        list.StatusCode.Should().Be(HttpStatusCode.OK);
        var agents = await DevicesApp.JsonAsync(list);
        agents.EnumerateArray().Should().ContainSingle(a => a.GetProperty("id").GetGuid() == agentId && !a.GetProperty("revoked").GetBoolean());

        (await app.ListAgentsRawAsync(guest.Login)).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        using var revoke = await app.RevokeRawAsync(owner, agentId, "teste");
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Agents.SingleAsync(Ct)).IsRevoked.Should().BeTrue();
    }

    [Fact]
    public async Task Owner_StillApprovesEverythingThroughTheAdministratorRoute_WithThePasskey()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        using var authenticator = new UniOver.IntegrationTests.Identity.Passkeys.VirtualAuthenticator();
        var owner = await app.LoginAsync();
        await app.RegisterPasskeyAsync(owner, authenticator);
        var started = await app.StartAsync();
        await app.ConfirmApproveAsync(owner, authenticator);

        using var response = await app.ApproveWithTvRawAsync(owner, started.UserCode, [Guid.NewGuid()], tvName: "Sala");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var tv = TvApp.CreateContext(app.Database.OwnerConnection);
        var row = await tv.Tvs.SingleAsync(Ct);
        row.IsDefault.Should().BeTrue();
        (await tv.TvMembers.CountAsync(Ct)).Should().Be(1);
    }

    // ---- a reconfirmação com a senha ----

    [Fact]
    public async Task APasswordCannotConfirmAnActionThatNeedsThePasskey()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();

        foreach (var action in new[] { "tv.bind-agent", "identity.guest-invite", "identity.permissions-change", "identity.passkey-remove", "outra.coisa" })
        {
            using var response = await app.ConfirmWithPasswordRawAsync(guest.Login, guest.Password, action);
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest, action);
        }

        await using var identity = IdentityApp.CreateContext(app.Database.OwnerConnection);
        (await identity.StepUpConfirmations.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task TheOwner_CannotConfirmWithThePassword()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await app.ConfirmWithPasswordRawAsync(owner, app.OwnerPassword);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var identity = IdentityApp.CreateContext(app.Database.OwnerConnection);
        (await identity.StepUpConfirmations.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task AWrongPassword_IsRefused_Audited_AndCountsTowardTheLockout()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();

        using var wrong = await app.ConfirmWithPasswordRawAsync(guest.Login, "senha-errada-aqui");
        wrong.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await ReadTypeAsync(wrong)).Should().EndWith("/invalid-password");

        await using (var identity = IdentityApp.CreateContext(app.Database.OwnerConnection))
        {
            var failed = await identity.LoginAudit.SingleAsync(a => a.Event == AuditEvents.StepUpFailed, Ct);
            failed.UserId.Should().Be(guest.UserId);
            failed.Detail.Should().Be("devices.pair-self|password");
            (await identity.Users.SingleAsync(u => u.Id == guest.UserId, Ct)).FailedLoginCount.Should().Be(1);
            (await identity.StepUpConfirmations.CountAsync(Ct)).Should().Be(0);
        }

        // Errar de novo até o bloqueio: depois dele nem a senha certa passa (e o aviso diz quanto esperar).
        for (var n = 0; n < 4; n++)
        {
            using var again = await app.ConfirmWithPasswordRawAsync(guest.Login, "senha-errada-aqui");
            again.StatusCode.Should().BeOneOf(HttpStatusCode.Forbidden, HttpStatusCode.TooManyRequests);
        }

        using var locked = await app.ConfirmWithPasswordRawAsync(guest.Login, guest.Password);
        locked.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        locked.Headers.RetryAfter.Should().NotBeNull();
    }

    [Fact]
    public async Task TheConfirmationNeedsALoginAndAPassword()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync();

        using var anonymous = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/step-up/password", new { action = DevicesApp.PairSelfAction, password = guest.Password });
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        using var withoutPassword = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/step-up/password", new { action = DevicesApp.PairSelfAction }, guest.Login.AccessToken);
        withoutPassword.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
