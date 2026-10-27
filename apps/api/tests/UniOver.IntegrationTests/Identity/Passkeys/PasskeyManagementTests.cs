using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity.Passkeys;

[Collection(PostgresGroup.Name)]
public sealed class PasskeyManagementTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string PasskeyUrl(Guid id) => $"/api/v1/identity/passkeys/{id}";

    [Fact]
    public async Task Rename_UpdatesTheName_AndRejectsEmptyOrUnknown()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        var created = await app.RegisterAsync(login, authenticator, "Antigo");
        var id = created.GetProperty("id").GetGuid();

        using var renamed = await app.SendAsync(HttpMethod.Patch, PasskeyUrl(id), new { name = "  iPhone 12  " }, login.AccessToken);
        using var empty = await app.SendAsync(HttpMethod.Patch, PasskeyUrl(id), new { name = " " }, login.AccessToken);
        using var unknown = await app.SendAsync(HttpMethod.Patch, PasskeyUrl(Guid.NewGuid()), new { name = "X" }, login.AccessToken);
        using var anonymous = await app.SendAsync(HttpMethod.Patch, PasskeyUrl(id), new { name = "X" });

        renamed.StatusCode.Should().Be(HttpStatusCode.OK);
        (await PasskeyApp.JsonAsync(renamed)).GetProperty("name").GetString().Should().Be("iPhone 12");
        empty.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        unknown.StatusCode.Should().Be(HttpStatusCode.NotFound);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await using var db = app.Db();
        (await db.Passkeys.SingleAsync(Ct)).Name.Should().Be("iPhone 12");
    }

    [Fact]
    public async Task List_RequiresAuthentication_AndStartsEmpty()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var anonymous = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/passkeys");
        using var empty = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/passkeys", bearer: login.AccessToken);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await PasskeyApp.JsonAsync(empty)).GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task Remove_WithoutConfirmation_Returns403StepUpRequired_ForTheRemovalAction()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var first = new VirtualAuthenticator();
        using var second = new VirtualAuthenticator();
        var id = (await app.RegisterAsync(login, first)).GetProperty("id").GetGuid();
        await app.RegisterAsync(login, second);

        using var response = await app.SendAsync(HttpMethod.Delete, PasskeyUrl(id), bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var problem = await PasskeyApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/step-up-required");
        problem.GetProperty("action").GetString().Should().Be(StepUpActions.PasskeyRemove);
        await using var db = app.Db();
        (await db.Passkeys.CountAsync(Ct)).Should().Be(2, "sem confirmação nada é removido");
    }

    [Fact]
    public async Task Remove_TheLastPasskey_Returns409_EvenWithConfirmation()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var only = new VirtualAuthenticator();
        var id = (await app.RegisterAsync(login, only)).GetProperty("id").GetGuid();
        (await app.ConfirmAsync(login, only, StepUpActions.PasskeyRemove)).StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.SendAsync(HttpMethod.Delete, PasskeyUrl(id), bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await PasskeyApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/last-passkey");
        await using var db = app.Db();
        (await db.Passkeys.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Remove_WithConfirmation_RemovesOne_Audits_AndTheRemovedKeyNoLongerConfirms()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var keep = new VirtualAuthenticator();
        using var drop = new VirtualAuthenticator();
        await app.RegisterAsync(login, keep);
        var dropId = (await app.RegisterAsync(login, drop)).GetProperty("id").GetGuid();
        (await app.ConfirmAsync(login, drop, StepUpActions.PasskeyRemove)).StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.SendAsync(HttpMethod.Delete, PasskeyUrl(dropId), bearer: login.AccessToken);
        drop.SignCount = 5;
        var (challengeId, options) = await app.BeginStepUpAsync(login, "teste.acao");
        using var withRemoved = await app.CompleteStepUpRawAsync(login, challengeId, drop.CreateAssertion(options));

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        withRemoved.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.Passkeys.SingleAsync(Ct)).CredentialId.Should().Equal(keep.CredentialId);
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.PasskeyRemoved, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ConcurrentRemovals_CannotDeleteTheLastTwoPasskeys()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var first = new VirtualAuthenticator();
        using var second = new VirtualAuthenticator();
        var firstId = (await app.RegisterAsync(login, first)).GetProperty("id").GetGuid();
        var secondId = (await app.RegisterAsync(login, second)).GetProperty("id").GetGuid();
        (await app.ConfirmAsync(login, first, StepUpActions.PasskeyRemove)).StatusCode.Should().Be(HttpStatusCode.OK);

        await using var db = app.Db();
        await db.Database.ExecuteSqlRawAsync(
            "CREATE FUNCTION identity.delay_passkey_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN OLD; END $$",
            Ct);
        await db.Database.ExecuteSqlRawAsync(
            "CREATE TRIGGER delay_passkey_delete BEFORE DELETE ON identity.passkeys FOR EACH ROW EXECUTE FUNCTION identity.delay_passkey_delete()",
            Ct);

        try
        {
            using var firstRequest = new HttpRequestMessage(HttpMethod.Delete, PasskeyUrl(firstId));
            firstRequest.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", login.AccessToken);
            firstRequest.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());
            using var secondRequest = new HttpRequestMessage(HttpMethod.Delete, PasskeyUrl(secondId));
            secondRequest.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", login.AccessToken);
            secondRequest.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());

            var responses = await Task.WhenAll(app.Client.SendAsync(firstRequest, Ct), app.Client.SendAsync(secondRequest, Ct));
            using var firstResponse = responses[0];
            using var secondResponse = responses[1];

            new[] { firstResponse.StatusCode, secondResponse.StatusCode }
                .Should().ContainSingle(status => status == HttpStatusCode.NoContent);
            new[] { firstResponse.StatusCode, secondResponse.StatusCode }
                .Should().ContainSingle(status => status == HttpStatusCode.Conflict);
            (await db.Passkeys.CountAsync(Ct)).Should().Be(1);
        }
        finally
        {
            await db.Database.ExecuteSqlRawAsync("DROP TRIGGER IF EXISTS delay_passkey_delete ON identity.passkeys", Ct);
            await db.Database.ExecuteSqlRawAsync("DROP FUNCTION IF EXISTS identity.delay_passkey_delete()", Ct);
        }
    }

    [Fact]
    public async Task Remove_UnknownPasskey_Returns404_AfterConfirmation()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var first = new VirtualAuthenticator();
        using var second = new VirtualAuthenticator();
        await app.RegisterAsync(login, first);
        await app.RegisterAsync(login, second);
        (await app.ConfirmAsync(login, first, StepUpActions.PasskeyRemove)).StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.SendAsync(HttpMethod.Delete, PasskeyUrl(Guid.NewGuid()), bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Production_WithoutRelyingPartyConfiguration_FailsClearlyOnFirstUse_ButTheHostStarts()
    {
        await using var app = await PasskeyApp.StartAsync(
            postgres, new PasskeyAppOptions { Environment = "Production", PasskeyConfiguration = false });
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { password = app.OwnerPassword }, login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.InternalServerError);
        app.Logs.Lines.Should().Contain(l => l.Contains("Modules:Identity:Passkeys:RpId", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Production_UsesTheRegisteredConfigurationNames()
    {
        var extra = new Dictionary<string, string?>
        {
            ["Modules:Identity:Passkeys:RpId"] = "uniover.onrender.com",
            ["Modules:Identity:Passkeys:Origins:0"] = "https://uniover.onrender.com",
        };
        await using var app = await PasskeyApp.StartAsync(
            postgres, new PasskeyAppOptions { Environment = "Production", PasskeyConfiguration = false, Extra = extra });
        var login = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator(rpId: "uniover.onrender.com", origin: "https://uniover.onrender.com");

        var (challengeId, options) = await app.BeginRegistrationAsync(login);
        using var created = await app.CompleteRegistrationRawAsync(login, challengeId, authenticator.CreateAttestation(options));

        options.GetProperty("rp").GetProperty("id").GetString().Should().Be("uniover.onrender.com");
        created.StatusCode.Should().Be(HttpStatusCode.Created);
    }
}
