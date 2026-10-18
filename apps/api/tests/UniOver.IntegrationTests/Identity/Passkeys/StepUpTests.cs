using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity.Passkeys;

[Collection(PostgresGroup.Name)]
public sealed class StepUpTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(PasskeyApp App, LoggedIn Login, VirtualAuthenticator Authenticator)> StartRegisteredAsync(
        PasskeyAppOptions? options = null, bool countsSignatures = true)
    {
        var app = await PasskeyApp.StartAsync(postgres, options);
        var login = await app.LoginAsync();
        var authenticator = new VirtualAuthenticator(countsSignatures: countsSignatures);
        await app.RegisterAsync(login, authenticator);
        return (app, login, authenticator);
    }

    [Fact]
    public async Task StepUpOptions_WithoutAnyPasskey_Returns404NoPasskey()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/step-up/options", new { action = "teste.acao" }, login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await PasskeyApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/no-passkey");
    }

    [Theory]
    [InlineData("")]
    [InlineData("Teste.Acao")]
    [InlineData("tv power-off")]
    [InlineData(".inicio")]
    [InlineData("fim.")]
    [InlineData("dois..pontos")]
    public async Task StepUpOptions_WithInvalidAction_Returns400(string action)
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/step-up/options", new { action }, login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task StepUpOptions_WithAnActionOver64Characters_Returns400()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/step-up/options", new { action = new string('a', 65) }, login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task StepUpOptions_AskForAssertionWithUserVerification_AndBindTheChallengeToTheAction()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        var (challengeId, options) = await app.BeginStepUpAsync(login, "teste.acao");

        options.GetProperty("rpId").GetString().Should().Be("localhost");
        options.GetProperty("userVerification").GetString().Should().Be("required");
        options.GetProperty("allowCredentials").GetArrayLength().Should().Be(1);

        await using var db = app.Db();
        var challenge = await db.WebAuthnChallenges.SingleAsync(c => c.Id == challengeId, Ct);
        challenge.Purpose.Should().Be(ChallengePurposes.StepUp);
        challenge.Action.Should().Be("teste.acao");
    }

    [Fact]
    public async Task StepUp_HappyPath_RecordsConfirmation_UpdatesThePasskey_AndAudits()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        authenticator.SignCount = 7;

        using var response = await app.ConfirmAsync(login, authenticator, "teste.acao");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await PasskeyApp.JsonAsync(response);
        body.GetProperty("action").GetString().Should().Be("teste.acao");
        body.GetProperty("expiresAt").GetDateTimeOffset().Should().Be(app.Time.GetUtcNow() + TimeSpan.FromMinutes(5));

        await using var db = app.Db();
        var confirmation = await db.StepUpConfirmations.SingleAsync(Ct);
        confirmation.Action.Should().Be("teste.acao");
        confirmation.UserId.Should().Be((await db.Users.SingleAsync(Ct)).Id);
        var passkey = await db.Passkeys.SingleAsync(Ct);
        passkey.SignCount.Should().Be(7);
        passkey.LastUsedAt.Should().Be(app.Time.GetUtcNow());
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.StepUpSucceeded && a.Detail == "teste.acao", Ct)).Should().Be(1);
        (await db.WebAuthnChallenges.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task StepUpPolicy_WithoutConfirmation_Returns403StepUpRequired_WithTheAction()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        using var response = await app.CallDangerousAsync(login);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        response.Content.Headers.ContentType!.MediaType.Should().Be("application/problem+json");
        var problem = await PasskeyApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/step-up-required");
        problem.GetProperty("code").GetString().Should().Be("step_up_required");
        problem.GetProperty("action").GetString().Should().Be("teste.acao");
        problem.GetProperty("status").GetInt32().Should().Be(403);
    }

    [Fact]
    public async Task StepUpPolicy_WithoutLogin_StaysA401_NotAStepUpError()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);

        using var response = await app.SendAsync(HttpMethod.Post, PasskeyApp.DangerousRoute);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task StepUpPolicy_WithConfirmation_Returns200()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        (await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.CallDangerousAsync(login);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Confirmation_ExpiresExactlyAfterTheConfiguredMinutes()
    {
        var (app, login, authenticator) = await StartRegisteredAsync(new PasskeyAppOptions { StepUpMinutes = 3 });
        await using var appScope = app;
        using var authScope = authenticator;
        (await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);

        app.Time.Advance(TimeSpan.FromMinutes(3) - TimeSpan.FromSeconds(1));
        using var inside = await app.CallDangerousAsync(login);
        app.Time.Advance(TimeSpan.FromSeconds(1));
        using var atTheLimit = await app.CallDangerousAsync(login);
        app.Time.Advance(TimeSpan.FromMinutes(1));
        using var after = await app.CallDangerousAsync(login);

        inside.StatusCode.Should().Be(HttpStatusCode.OK);
        atTheLimit.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        after.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PasskeyApp.JsonAsync(after)).GetProperty("code").GetString().Should().Be("step_up_required");
    }

    [Fact]
    public async Task Confirmation_DefaultsToFiveMinutes_NotTheWholeSession()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        (await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);

        app.Time.Advance(TimeSpan.FromMinutes(4));
        using var inside = await app.CallDangerousAsync(login);
        app.Time.Advance(TimeSpan.FromMinutes(1.5));
        using var after = await app.CallDangerousAsync(login);

        inside.StatusCode.Should().Be(HttpStatusCode.OK);

        // O JWT (10 min) ainda vale: o que acabou foi só a confirmação.
        after.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Confirmation_OfOneAction_DoesNotUnlockAnotherAction()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        (await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);

        using var other = await app.CallDangerousAsync(login, PasskeyApp.OtherDangerousRoute);

        other.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PasskeyApp.JsonAsync(other)).GetProperty("action").GetString().Should().Be(PasskeyApp.OtherAction);
    }

    [Fact]
    public async Task Confirmation_OfOneSession_DoesNotUnlockAnotherSession()
    {
        var (app, phone, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var laptop = await app.LoginAsync();
        (await app.ConfirmAsync(phone, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);

        using var onPhone = await app.CallDangerousAsync(phone);
        using var onLaptop = await app.CallDangerousAsync(laptop);

        onPhone.StatusCode.Should().Be(HttpStatusCode.OK);
        onLaptop.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Logout_InvalidatesTheConfirmation_EvenWithTheAccessTokenStillValid()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        (await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await app.CallDangerousAsync(login)).StatusCode.Should().Be(HttpStatusCode.OK);

        using var logout = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: login.AccessToken);
        using var after = await app.CallDangerousAsync(login);

        logout.StatusCode.Should().Be(HttpStatusCode.NoContent);
        after.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.StepUpConfirmations.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task ARevokedSession_CannotOpenANewConfirmation()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var (challengeId, options) = await app.BeginStepUpAsync(login, PasskeyApp.DangerousAction);
        using var logout = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: login.AccessToken);

        using var response = await app.CompleteStepUpRawAsync(login, challengeId, authenticator.CreateAssertion(options));

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.StepUpConfirmations.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Confirming_AgainRenewsTheWindow_WithoutStackingRows()
    {
        var (app, login, authenticator) = await StartRegisteredAsync(new PasskeyAppOptions { StepUpMinutes = 3 });
        await using var appScope = app;
        using var authScope = authenticator;
        authenticator.SignCount = 1;
        (await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);
        app.Time.Advance(TimeSpan.FromMinutes(2));
        authenticator.SignCount = 2;
        (await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);

        app.Time.Advance(TimeSpan.FromMinutes(2));
        using var response = await app.CallDangerousAsync(login);

        response.StatusCode.Should().Be(HttpStatusCode.OK, "a segunda confirmação renovou a janela");
        await using var db = app.Db();
        (await db.StepUpConfirmations.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Challenge_IsSingleUse_ReplayFailsAndIsAudited()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        authenticator.SignCount = 1;
        var (challengeId, options) = await app.BeginStepUpAsync(login, PasskeyApp.DangerousAction);
        var assertion = authenticator.CreateAssertion(options);

        using var first = await app.CompleteStepUpRawAsync(login, challengeId, assertion);
        using var replay = await app.CompleteStepUpRawAsync(login, challengeId, assertion);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        replay.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PasskeyApp.JsonAsync(replay)).GetProperty("type").GetString().Should().EndWith("/step-up-failed");
        await using var db = app.Db();
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.StepUpFailed, Ct)).Should().Be(1);
        (await db.StepUpConfirmations.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Challenge_ExpiresAfterTwoMinutes()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        authenticator.SignCount = 1;
        var (challengeId, options) = await app.BeginStepUpAsync(login, PasskeyApp.DangerousAction);
        var assertion = authenticator.CreateAssertion(options);

        app.Time.Advance(TimeSpan.FromMinutes(2) + TimeSpan.FromSeconds(1));
        using var response = await app.CompleteStepUpRawAsync(login, challengeId, assertion);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task ARegistrationChallenge_CannotBeUsedToConfirmAnAction()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        authenticator.SignCount = 1;
        var (registrationChallenge, options) = await app.BeginRegistrationAsync(login);

        using var response = await app.CompleteStepUpRawAsync(login, registrationChallenge, authenticator.CreateAssertion(options));

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.StepUpConfirmations.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Assertion_WithRegressiveSignCount_Fails_AndKeepsTheStoredCounter()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        authenticator.SignCount = 10;
        (await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);

        // Contador que volta (chave clonada) ou que repete é recusado.
        authenticator.SignCount = 9;
        using var regressive = await app.ConfirmAsync(login, authenticator, PasskeyApp.OtherAction);
        authenticator.SignCount = 10;
        using var repeated = await app.ConfirmAsync(login, authenticator, PasskeyApp.OtherAction);
        authenticator.SignCount = 11;
        using var advancing = await app.ConfirmAsync(login, authenticator, PasskeyApp.OtherAction);

        regressive.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        repeated.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        advancing.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.Passkeys.SingleAsync(Ct)).SignCount.Should().Be(11);
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.StepUpFailed, Ct)).Should().Be(2);
        (await db.LoginAudit.Where(a => a.Event == AuditEvents.StepUpFailed).Select(a => a.Detail).ToListAsync(Ct))
            .Should().OnlyContain(r => r == "teste.outra|verification" || r == "teste.outra|sign-count");
    }

    [Fact]
    public async Task AnAuthenticatorThatDoesNotCount_StaysValidWithZero()
    {
        var (app, login, authenticator) = await StartRegisteredAsync(countsSignatures: false);
        await using var appScope = app;
        using var authScope = authenticator;

        using var first = await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction);
        using var second = await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Assertion_FromAnUnregisteredCredential_IsRejected()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        using var stranger = new VirtualAuthenticator();
        var (challengeId, options) = await app.BeginStepUpAsync(login, PasskeyApp.DangerousAction);

        using var response = await app.CompleteStepUpRawAsync(login, challengeId, stranger.CreateAssertion(options));

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Assertion_FromAnotherOrigin_OrWithoutUserVerification_IsRejected()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        authenticator.SignCount = 1;

        var (firstId, firstOptions) = await app.BeginStepUpAsync(login, PasskeyApp.DangerousAction);
        authenticator.Origin = "https://outro-site.example";
        using var phishing = await app.CompleteStepUpRawAsync(login, firstId, authenticator.CreateAssertion(firstOptions));

        authenticator.Origin = "https://localhost";
        var (secondId, secondOptions) = await app.BeginStepUpAsync(login, PasskeyApp.DangerousAction);
        using var noVerification = await app.CompleteStepUpRawAsync(
            login, secondId, authenticator.CreateAssertion(secondOptions, userVerified: false));

        phishing.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        noVerification.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Os dois caíram na verificação da assinatura/regras do WebAuthn, não em outro defeito do pedido.
        await using var db = app.Db();
        var reasons = await db.LoginAudit.Where(a => a.Event == AuditEvents.StepUpFailed).Select(a => a.Detail).ToListAsync(Ct);
        reasons.Should().OnlyContain(r => r == "teste.acao|verification").And.HaveCount(2);
    }

    [Fact]
    public async Task Assertion_WithTamperedSignature_IsRejected()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        authenticator.SignCount = 1;
        var (challengeId, options) = await app.BeginStepUpAsync(login, PasskeyApp.DangerousAction);
        var other = await app.BeginStepUpAsync(login, PasskeyApp.OtherAction);

        // Resposta assinada para o desafio de outra ação, entregue no desafio desta: a assinatura não confere.
        using var response = await app.CompleteStepUpRawAsync(login, challengeId, authenticator.CreateAssertion(other.Options));

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await app.CallDangerousAsync(login)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task StepUpComplete_MalformedPayload_IsA4xx_Never500()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var (challengeId, _) = await app.BeginStepUpAsync(login, PasskeyApp.DangerousAction);

        var garbage = new
        {
            id = "AAAA",
            rawId = "AAAA",
            type = "public-key",
            response = new { authenticatorData = "AAAA", clientDataJSON = "AAAA", signature = "AAAA" },
        };
        using var response = await app.CompleteStepUpRawAsync(login, challengeId, garbage);
        using var empty = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/step-up/complete", new { challengeId }, login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        empty.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task StepUpEndpoints_RequireAuthentication()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);

        using var options = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/step-up/options", new { action = "teste.acao" });
        using var complete = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/step-up/complete", new { });

        options.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        complete.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task NothingSensitive_ReachesTheLogs()
    {
        var (app, login, authenticator) = await StartRegisteredAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        authenticator.SignCount = 1;
        var (challengeId, options) = await app.BeginStepUpAsync(login, PasskeyApp.DangerousAction);
        var challenge = options.GetProperty("challenge").GetString()!;
        (await app.CompleteStepUpRawAsync(login, challengeId, authenticator.CreateAssertion(options))).Dispose();

        var text = string.Join('\n', app.Logs.Lines);

        text.Should().NotContain(challenge);
        text.Should().NotContain(VirtualAuthenticator.B64(authenticator.CredentialId));
        text.Should().NotContain(login.AccessToken);
        text.Should().NotContain(app.OwnerPassword);
    }
}
