using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity.Passkeys;

[Collection(PostgresGroup.Name)]
public sealed class PasskeyRegistrationTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task RegistrationOptions_WithoutPassword_Returns400()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var empty = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { password = "" }, login.AccessToken);
        using var missing = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { }, login.AccessToken);

        empty.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        missing.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task RegistrationOptions_WithWrongPassword_Returns403_Audits_AndCountsTowardsLockout()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { password = "senha-errada-qualquer" }, login.AccessToken);

        // 403 e não 401: o app trataria 401 como sessão vencida e tentaria renovar.
        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PasskeyApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/invalid-password");

        await using var db = app.Db();
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.LoginFailed && a.Detail == "passkey-registration", Ct)).Should().Be(1);
        (await db.Users.SingleAsync(Ct)).FailedLoginCount.Should().Be(1);
        (await db.WebAuthnChallenges.CountAsync(Ct)).Should().Be(0, "sem a senha nenhum desafio é emitido");
    }

    [Fact]
    public async Task RegistrationOptions_RequireAuthentication()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { password = app.OwnerPassword });

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task RegistrationOptions_ComeFromTheConfiguredRelyingParty_AndRequireUserVerification()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        var (challengeId, options) = await app.BeginRegistrationAsync(login);

        options.GetProperty("rp").GetProperty("id").GetString().Should().Be("localhost");
        options.GetProperty("authenticatorSelection").GetProperty("userVerification").GetString().Should().Be("required");
        options.GetProperty("authenticatorSelection").GetProperty("residentKey").GetString().Should().Be("preferred");
        options.GetProperty("attestation").GetString().Should().Be("none");
        options.GetProperty("challenge").GetString().Should().NotBeNullOrEmpty();

        await using var db = app.Db();
        var challenge = await db.WebAuthnChallenges.SingleAsync(Ct);
        challenge.Id.Should().Be(challengeId);
        challenge.Purpose.Should().Be(ChallengePurposes.Register);
        challenge.ExpiresAt.Should().Be(app.Time.GetUtcNow() + TimeSpan.FromMinutes(2));
    }

    [Fact]
    public async Task Registration_HappyPath_StoresOnlyThePublicKey_Lists_AndAudits()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();

        var created = await app.RegisterAsync(login, authenticator, "  Notebook  ");

        created.GetProperty("name").GetString().Should().Be("Notebook");

        using var list = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/passkeys", bearer: login.AccessToken);
        list.StatusCode.Should().Be(HttpStatusCode.OK);
        var items = await PasskeyApp.JsonAsync(list);
        items.GetArrayLength().Should().Be(1);
        items[0].GetProperty("name").GetString().Should().Be("Notebook");
        items[0].TryGetProperty("publicKey", out _).Should().BeFalse("a lista nunca expõe a chave");
        items[0].TryGetProperty("credentialId", out _).Should().BeFalse();

        await using var db = app.Db();
        var stored = await db.Passkeys.SingleAsync(Ct);
        stored.CredentialId.Should().Equal(authenticator.CredentialId);
        stored.PublicKey.Should().NotBeEmpty();
        stored.SignCount.Should().Be(0);
        (await db.WebAuthnChallenges.CountAsync(Ct)).Should().Be(0, "o desafio é de uso único");
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.PasskeyRegistered, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Registration_WithoutName_UsesTheDefaultName_AndTooLongNameIsRejected()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var first = new VirtualAuthenticator();
        using var second = new VirtualAuthenticator();

        var created = await app.RegisterAsync(login, first);
        created.GetProperty("name").GetString().Should().Be(PasskeyRules.DefaultName);

        var (challengeId, options) = await app.BeginRegistrationAsync(login);
        using var tooLong = await app.CompleteRegistrationRawAsync(
            login, challengeId, second.CreateAttestation(options), new string('x', PasskeyRules.MaxNameLength + 1));
        tooLong.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Registration_ChallengeIsSingleUse_ReplayFails()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        var (challengeId, options) = await app.BeginRegistrationAsync(login);
        var attestation = authenticator.CreateAttestation(options);

        using var first = await app.CompleteRegistrationRawAsync(login, challengeId, attestation);
        using var replay = await app.CompleteRegistrationRawAsync(login, challengeId, attestation);

        first.StatusCode.Should().Be(HttpStatusCode.Created);
        replay.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await PasskeyApp.JsonAsync(replay)).GetProperty("type").GetString().Should().EndWith("/passkey-registration-failed");

        await using var db = app.Db();
        (await db.Passkeys.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Registration_FromAnotherOrigin_IsRejected_AndBurnsTheChallenge()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var phishing = new VirtualAuthenticator(origin: "https://outro-site.example");
        var (challengeId, options) = await app.BeginRegistrationAsync(login);

        using var response = await app.CompleteRegistrationRawAsync(login, challengeId, phishing.CreateAttestation(options));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.Passkeys.CountAsync(Ct)).Should().Be(0);
        (await db.WebAuthnChallenges.CountAsync(Ct)).Should().Be(0, "uma tentativa que falha também gasta o desafio");
    }

    [Fact]
    public async Task Registration_ForAnotherRelyingParty_IsRejected()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var other = new VirtualAuthenticator(rpId: "outro-site.example");
        var (challengeId, options) = await app.BeginRegistrationAsync(login);

        using var response = await app.CompleteRegistrationRawAsync(login, challengeId, other.CreateAttestation(options));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Registration_WithoutUserVerification_IsRejected()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        var (challengeId, options) = await app.BeginRegistrationAsync(login);

        using var response = await app.CompleteRegistrationRawAsync(
            login, challengeId, authenticator.CreateAttestation(options, userVerified: false));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Registration_ChallengeExpiresAfterTwoMinutes()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        var (challengeId, options) = await app.BeginRegistrationAsync(login);
        var attestation = authenticator.CreateAttestation(options);

        app.Time.Advance(TimeSpan.FromMinutes(2) + TimeSpan.FromSeconds(1));
        using var response = await app.CompleteRegistrationRawAsync(login, challengeId, attestation);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Registration_MalformedPayload_IsA400_Never500()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var (challengeId, _) = await app.BeginRegistrationAsync(login);

        var garbage = new
        {
            id = "AAAA",
            rawId = "AAAA",
            type = "public-key",
            response = new { attestationObject = "AAAA", clientDataJSON = "AAAA" },
        };
        using var response = await app.CompleteRegistrationRawAsync(login, challengeId, garbage);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Registration_CannotReuseACredentialThatAlreadyExists()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(login, authenticator);

        var (challengeId, options) = await app.BeginRegistrationAsync(login);
        using var again = await app.CompleteRegistrationRawAsync(login, challengeId, authenticator.CreateAttestation(options));

        again.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.Passkeys.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task RegistrationEndpoints_UseTheLoginRateLimit_WithRetryAfter()
    {
        // O próprio login gasta uma das três vagas da janela (a política "login" é compartilhada).
        var extra = new Dictionary<string, string?> { ["RateLimiting:login:Permitted"] = "3" };
        await using var app = await PasskeyApp.StartAsync(postgres, new PasskeyAppOptions { Extra = extra });
        var login = await app.LoginAsync();

        await app.BeginRegistrationAsync(login);
        await app.BeginRegistrationAsync(login);
        using var limited = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { password = app.OwnerPassword }, login.AccessToken);

        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        limited.Headers.RetryAfter.Should().NotBeNull();
    }

    [Fact]
    public async Task ExpiredChallengesAndConfirmations_AreSweptWhenSomethingNewIsWritten()
    {
        await using var app = await PasskeyApp.StartAsync(postgres, new PasskeyAppOptions { StepUpMinutes = 3 });
        var login = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(login, authenticator);
        (await app.ConfirmAsync(login, authenticator, PasskeyApp.DangerousAction)).StatusCode.Should().Be(HttpStatusCode.OK);
        await app.BeginRegistrationAsync(login); // deixa um desafio sem uso

        app.Time.Advance(TimeSpan.FromMinutes(4));
        await app.BeginRegistrationAsync(login); // grava um desafio novo: varre o vencido

        await using var db = app.Db();
        (await db.WebAuthnChallenges.CountAsync(Ct)).Should().Be(1);
        (await db.StepUpConfirmations.CountAsync(Ct)).Should().Be(0);
    }
}
