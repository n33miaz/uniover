using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.Refresh;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.IntegrationTests.Identity;

/// <summary>
/// A recuperação do refresh cuja resposta se perdeu (a página do iPhone foi suspensa no meio da renovação) e os ataques
/// contra ela: o mesmo aparelho, provando a chave da família sobre um desafio de uso único, recupera UMA vez; qualquer
/// outra coisa que reapresente um token já girado revoga a família.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class RefreshRecoveryTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>
    /// A cena do iPhone: login com chave do aparelho, uma renovação que o servidor concluiu e cuja resposta se perdeu. O
    /// teste só conhece o cookie ANTIGO (<see cref="OldSecret"/>); o sucessor existe no banco, sem uso.
    /// </summary>
    private sealed class LostResponse(IdentityApp app, TestDevice device, LoggedIn login, string lostSecret) : IAsyncDisposable
    {
        public IdentityApp App { get; } = app;

        public TestDevice Device { get; } = device;

        public LoggedIn Login { get; } = login;

        public string OldSecret => Login.RefreshSecret;

        /// <summary>O cookie que o servidor emitiu e o aparelho nunca recebeu (só o teste o sabe, para tentar usá-lo).</summary>
        public string LostSecret { get; } = lostSecret;

        public static async Task<LostResponse> StartAsync(PostgresFixture postgres, Dictionary<string, string?>? extra = null, bool withKey = true)
        {
            var app = await IdentityApp.StartAsync(postgres, extra is null ? null : new IdentityAppOptions { Extra = extra });
            var device = new TestDevice();
            var login = await app.LoginAsync(device: withKey ? device : null);
            using var rotated = await app.RefreshRawAsync(login.RefreshSecret);
            rotated.StatusCode.Should().Be(HttpStatusCode.OK);
            var lost = IdentityApp.Cookies(rotated).Single(c => c.Name == "uo_rt").Value;

            // Passa a tolerância de giro simultâneo (3 s): o aparelho volta depois de um tempo, não no mesmo instante.
            app.Time.Advance(TimeSpan.FromSeconds(30));
            return new LostResponse(app, device, login, lost);
        }

        public async ValueTask DisposeAsync()
        {
            Device.Dispose();
            await App.DisposeAsync();
        }
    }

    private static async Task<RefreshToken> TokenOfAsync(IdentityDbContext db, string secret)
    {
        var hash = SecretTokens.Hash(secret)!;
        return await db.RefreshTokens.AsNoTracking().SingleAsync(t => t.TokenHash == hash, Ct);
    }

    private static async Task<string?> LastReuseDetailAsync(IdentityApp app)
    {
        await using var db = app.Db();
        var entry = await db.LoginAudit.OrderByDescending(a => a.OccurredAt).FirstAsync(a => a.Event == AuditEvents.RefreshReuseDetected, Ct);
        return entry.Detail;
    }

    private static async Task AssertFamilyRevokedAsync(IdentityApp app, string reason)
    {
        await using var db = app.Db();
        var tokens = await db.RefreshTokens.AsNoTracking().ToListAsync(Ct);
        tokens.Should().OnlyContain(t => t.RevokedAt != null && t.RevokedReason == RevokeReasons.Reuse, "toda a família cai");
        (await LastReuseDetailAsync(app)).Should().EndWith("|" + reason);
    }

    [Fact]
    public async Task Login_StoresTheDevicePublicKeyForTheFamily_AndIgnoresAnythingThatIsNotAP256Key()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var device = new TestDevice();

        var login = await app.LoginAsync(device: device);
        await app.LoginAsync(); // sem chave: família sem recuperação

        using var invalid = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/login", new { email = app.OwnerEmail, password = app.OwnerPassword },
            extraHeaders: new Dictionary<string, string> { ["X-UniOver-Device-Key"] = "lixo-que-nao-e-chave" });
        invalid.StatusCode.Should().Be(HttpStatusCode.OK, "uma chave ruim nunca derruba o login");

        await using var db = app.Db();
        var keys = await db.RefreshDeviceKeys.AsNoTracking().ToListAsync(Ct);
        keys.Should().ContainSingle().Which.PublicKey.Should().Be(device.PublicKey);
        var token = await TokenOfAsync(db, login.RefreshSecret);
        keys.Single().FamilyId.Should().Be(token.FamilyId);
        keys.Single().UserId.Should().Be(token.UserId);
    }

    [Fact]
    public async Task AGuestWhoAcceptedAnInviteWithAKey_RecoversALostResponse_LikeTheOwner()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var device = new TestDevice();
        var (_, invite) = await Guests.GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow());
        using var accepted = await Guests.GuestSeed.AcceptAsync(
            app.Client, invite, Guests.GuestSeed.NewEmail(), Guests.GuestSeed.NewPassword(), device: device);
        var login = await Guests.GuestSeed.ReadLoginAsync(accepted);
        await using (var db = app.Db())
        {
            (await db.RefreshDeviceKeys.AsNoTracking().SingleAsync(Ct)).PublicKey.Should().Be(device.PublicKey);
        }

        (await app.RefreshRawAsync(login.RefreshSecret)).Dispose();
        app.Time.Advance(TimeSpan.FromMinutes(2));
        using var recovered = await app.RecoverAsync(login.RefreshSecret, device);

        recovered.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Recovery_AfterALostResponse_IssuesANewSuccessorInTheSameFamily_AndAuditsIt()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var app = scene.App;

        app.Time.Advance(TimeSpan.FromMinutes(4));
        using var recovered = await app.RecoverAsync(scene.OldSecret, scene.Device);

        recovered.StatusCode.Should().Be(HttpStatusCode.OK);
        var cookie = IdentityApp.Cookies(recovered).Single(c => c.Name == "uo_rt");
        cookie.Value.Should().NotBe(scene.OldSecret).And.NotBe(scene.LostSecret);
        cookie.Has("httponly").Should().BeTrue();
        (await IdentityApp.JsonAsync(recovered)).GetProperty("accessToken").GetString().Should().NotBeNullOrEmpty();

        await using (var db = app.Db())
        {
            var tokens = await db.RefreshTokens.AsNoTracking().ToListAsync(Ct);
            tokens.Should().HaveCount(3).And.OnlyContain(t => t.RevokedAt == null);
            tokens.Select(t => t.FamilyId).Distinct().Should().ContainSingle();

            var old = await TokenOfAsync(db, scene.OldSecret);
            var lost = await TokenOfAsync(db, scene.LostSecret);
            var current = await TokenOfAsync(db, cookie.Value);
            old.RecoveredAt.Should().NotBeNull("o token apresentado gastou a única recuperação");
            lost.RecoveredAt.Should().NotBeNull("o sucessor consumido também não recupera de novo");
            lost.UsedAt.Should().NotBeNull();
            lost.ReplacedById.Should().Be(current.Id);
            current.UsedAt.Should().BeNull("só o sucessor novo segue ativo");
            tokens.Count(t => t.UsedAt == null).Should().Be(1);

            var audit = await db.LoginAudit.AsNoTracking().SingleAsync(a => a.Event == AuditEvents.RefreshRecovered, Ct);
            audit.UserId.Should().Be(old.UserId);
            audit.Detail.Should().Be("after-270s");
            (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.RefreshReuseDetected, Ct)).Should().Be(0);
            (await db.RefreshRecoveryChallenges.AsNoTracking().SingleAsync(Ct)).ConsumedAt.Should().NotBeNull("o desafio foi gasto");
        }

        // O sucessor novo gira normalmente, e a vida da sessão segue.
        app.Time.Advance(TimeSpan.FromMinutes(1));
        (await app.RefreshRawAsync(cookie.Value)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Recovery_TheSuccessorTheDeviceNeverReceived_CannotBeUsedAfterwards()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        using (await scene.App.RecoverAsync(scene.OldSecret, scene.Device))
        {
        }

        scene.App.Time.Advance(TimeSpan.FromSeconds(10));
        using var response = await scene.App.RefreshRawAsync(scene.LostSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.Chained);
    }

    [Fact]
    public async Task Recovery_OfTheSameTokenTwice_IsNotAllowed_NoChaining()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var app = scene.App;
        using var first = await app.RecoverAsync(scene.OldSecret, scene.Device);
        var recoveredSecret = IdentityApp.Cookies(first).Single(c => c.Name == "uo_rt").Value;
        first.StatusCode.Should().Be(HttpStatusCode.OK);

        // A resposta da recuperação também se perdeu: o aparelho ainda tem o cookie antigo e tenta de novo.
        app.Time.Advance(TimeSpan.FromSeconds(30));
        using var again = await app.ChallengeRawAsync(scene.OldSecret);

        again.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        IdentityApp.Cookies(again).Should().ContainSingle(c => c.Name == "uo_rt" && c.IsDeletion);
        await AssertFamilyRevokedAsync(app, RecoveryDenials.Chained);
        (await app.RefreshRawAsync(recoveredSecret)).StatusCode.Should().Be(HttpStatusCode.Unauthorized, "a sessão inteira caiu");
    }

    [Fact]
    public async Task Recovery_ReplayOfTheChallengeAndProofAlreadySpent_IsRejectedAndRevokes()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var app = scene.App;
        var (challenge, family) = await app.ChallengeAsync(scene.OldSecret);
        var proof = scene.Device.Sign(family, challenge);
        using var first = await app.RefreshWithProofAsync(scene.OldSecret, challenge, proof);
        first.StatusCode.Should().Be(HttpStatusCode.OK);

        using var replay = await app.RefreshWithProofAsync(scene.OldSecret, challenge, proof);

        replay.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(app, RecoveryDenials.Chained);
    }

    [Fact]
    public async Task Recovery_TwoRequestsWithTheSameChallengeAndProofAtOnce_HaveASingleWinner()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var app = scene.App;
        var (challenge, family) = await app.ChallengeAsync(scene.OldSecret);
        var proof = scene.Device.Sign(family, challenge);

        var results = await Task.WhenAll(
            Enumerable.Range(0, 4).Select(async _ =>
            {
                using var response = await app.RefreshWithProofAsync(scene.OldSecret, challenge, proof);
                return response.StatusCode;
            }));

        results.Count(s => s == HttpStatusCode.OK).Should().Be(1, "o desafio vale uma vez");
        results.Where(s => s != HttpStatusCode.OK).Should().OnlyContain(s => s == HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Recovery_WithoutChallengeAndProof_RevokesTheFamily()
    {
        await using var scene = await LostResponse.StartAsync(postgres);

        // Reapresentar o cookie antigo como um refresh comum é exatamente o que um token roubado faz.
        using var response = await scene.App.RefreshRawAsync(scene.OldSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.NoProof);
    }

    [Fact]
    public async Task Recovery_WithAChallengeButNoSignature_RevokesTheFamily()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var (challenge, _) = await scene.App.ChallengeAsync(scene.OldSecret);

        using var response = await scene.App.RefreshWithProofAsync(scene.OldSecret, challenge, null);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.NoProof);
    }

    [Theory]
    [InlineData("outra-chave")]
    [InlineData("lixo")]
    [InlineData("AAAA")]
    public async Task Recovery_WithASignatureThatDoesNotCheckOut_RevokesTheFamily(string kind)
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var (challenge, family) = await scene.App.ChallengeAsync(scene.OldSecret);
        using var thief = new TestDevice();
        var proof = kind == "outra-chave" ? thief.Sign(family, challenge) : kind;

        using var response = await scene.App.RefreshWithProofAsync(scene.OldSecret, challenge, proof);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        IdentityApp.Cookies(response).Should().ContainSingle(c => c.Name == "uo_rt" && c.IsDeletion);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.BadSignature);
    }

    [Fact]
    public async Task Recovery_WithAProofForAnotherFamily_RevokesOnlyTheFamilyThatWasAttacked()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var deviceA = new TestDevice();
        using var deviceB = new TestDevice();
        var loginA = await app.LoginAsync(device: deviceA);
        var loginB = await app.LoginAsync(device: deviceB);
        (await app.RefreshRawAsync(loginA.RefreshSecret)).Dispose();
        app.Time.Advance(TimeSpan.FromSeconds(30));
        var (challengeA, familyA) = await app.ChallengeAsync(loginA.RefreshSecret);

        // A chave da outra família assina a mensagem da família A.
        using var wrongKey = await app.RefreshWithProofAsync(loginA.RefreshSecret, challengeA, deviceB.Sign(familyA, challengeA));
        wrongKey.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        await using var db = app.Db();
        var tokenA = await TokenOfAsync(db, loginA.RefreshSecret);
        (await db.RefreshTokens.AsNoTracking().Where(t => t.FamilyId == tokenA.FamilyId).ToListAsync(Ct))
            .Should().OnlyContain(t => t.RevokedAt != null);
        (await TokenOfAsync(db, loginB.RefreshSecret)).RevokedAt.Should().BeNull("a outra família não foi tocada");
    }

    [Fact]
    public async Task Recovery_WithTheCorrectKeyButTheMessageOfAnotherFamily_RevokesTheFamily()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var (challenge, _) = await scene.App.ChallengeAsync(scene.OldSecret);
        var otherFamily = Guid.NewGuid().ToString("N");

        using var response = await scene.App.RefreshWithProofAsync(
            scene.OldSecret, challenge, scene.Device.Sign(otherFamily, challenge));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.BadSignature);
    }

    [Fact]
    public async Task Recovery_WithAChallengeIssuedToAnotherFamily_RevokesTheFamilyThatPresentedIt()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var deviceA = new TestDevice();
        using var deviceB = new TestDevice();
        var loginA = await app.LoginAsync(device: deviceA);
        var loginB = await app.LoginAsync(device: deviceB);
        (await app.RefreshRawAsync(loginA.RefreshSecret)).Dispose();
        (await app.RefreshRawAsync(loginB.RefreshSecret)).Dispose();
        app.Time.Advance(TimeSpan.FromSeconds(30));
        var (challengeB, familyB) = await app.ChallengeAsync(loginB.RefreshSecret);

        // O desafio e a assinatura são legítimos da família B, apresentados com o token da família A.
        using var response = await app.RefreshWithProofAsync(loginA.RefreshSecret, challengeB, deviceB.Sign(familyB, challengeB));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await using var db = app.Db();
        var tokenA = await TokenOfAsync(db, loginA.RefreshSecret);
        (await db.RefreshTokens.AsNoTracking().Where(t => t.FamilyId == tokenA.FamilyId).ToListAsync(Ct)).Should().OnlyContain(t => t.RevokedAt != null);
        (await LastReuseDetailAsync(app)).Should().EndWith("|" + RecoveryDenials.ChallengeInvalid);
    }

    [Fact]
    public async Task Recovery_ANewChallengeReplacesTheOneBefore_OnlyTheLastIsGood()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var (first, family) = await scene.App.ChallengeAsync(scene.OldSecret);
        var (second, _) = await scene.App.ChallengeAsync(scene.OldSecret);

        using var response = await scene.App.RefreshWithProofAsync(scene.OldSecret, first, scene.Device.Sign(family, first));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.ChallengeInvalid);
        second.Should().NotBe(first);
        await using var db = scene.App.Db();
        (await db.RefreshRecoveryChallenges.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Recovery_WithAChallengeThatWasAlreadyConsumed_RevokesTheFamily()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var (challenge, family) = await scene.App.ChallengeAsync(scene.OldSecret);
        await using (var db = scene.App.Db())
        {
            await db.RefreshRecoveryChallenges.ExecuteUpdateAsync(s => s.SetProperty(c => c.ConsumedAt, scene.App.Time.GetUtcNow()), Ct);
        }

        using var response = await scene.App.RefreshWithProofAsync(scene.OldSecret, challenge, scene.Device.Sign(family, challenge));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.ChallengeReplayed);
    }

    [Fact]
    public async Task Recovery_WithAChallengeThatExpired_RevokesTheFamily()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var (challenge, family) = await scene.App.ChallengeAsync(scene.OldSecret);
        scene.App.Time.Advance(TimeSpan.FromMinutes(3));

        using var response = await scene.App.RefreshWithProofAsync(scene.OldSecret, challenge, scene.Device.Sign(family, challenge));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.ChallengeReplayed);
    }

    [Fact]
    public async Task Challenge_AfterTheRecoveryWindow_RevokesTheFamily()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        scene.App.Time.Advance(TimeSpan.FromMinutes(11));

        using var response = await scene.App.ChallengeRawAsync(scene.OldSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        IdentityApp.Cookies(response).Should().ContainSingle(c => c.Name == "uo_rt" && c.IsDeletion);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.Window);
    }

    [Fact]
    public async Task Recovery_JustInsideTheWindow_StillWorks()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        scene.App.Time.Advance(TimeSpan.FromMinutes(9));

        using var response = await scene.App.RecoverAsync(scene.OldSecret, scene.Device);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Recovery_TurnedOffByConfiguration_FallsBackToTheStrictRule()
    {
        await using var scene = await LostResponse.StartAsync(
            postgres, new Dictionary<string, string?> { ["Modules:Identity:RefreshRecoverySeconds"] = "0" });

        using var response = await scene.App.ChallengeRawAsync(scene.OldSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.Window);
    }

    [Fact]
    public async Task Recovery_ForAFamilyWithoutADeviceKey_FallsBackToTheStrictRule()
    {
        await using var scene = await LostResponse.StartAsync(postgres, withKey: false);

        using var response = await scene.App.ChallengeRawAsync(scene.OldSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.NoKey);
        await using var db = scene.App.Db();
        (await db.RefreshRecoveryChallenges.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Recovery_WhenTheSuccessorWasAlreadyUsed_RevokesTheFamily()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        // Alguém além do aparelho tinha o cookie novo e o usou.
        (await scene.App.RefreshRawAsync(scene.LostSecret)).Dispose();
        scene.App.Time.Advance(TimeSpan.FromSeconds(10));

        using var response = await scene.App.ChallengeRawAsync(scene.OldSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await AssertFamilyRevokedAsync(scene.App, RecoveryDenials.SuccessorUsed);
    }

    [Fact]
    public async Task Challenge_ForATokenThatNeverRotated_NeedsNothing_AndLeavesNoChallengeBehind()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var device = new TestDevice();
        var login = await app.LoginAsync(device: device);

        using var response = await app.ChallengeRawAsync(login.RefreshSecret);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(response);
        body.GetProperty("challenge").ValueKind.Should().Be(System.Text.Json.JsonValueKind.Null);
        await using var db = app.Db();
        (await db.RefreshRecoveryChallenges.CountAsync(Ct)).Should().Be(0);
        (await db.RefreshTokens.CountAsync(t => t.RevokedAt != null, Ct)).Should().Be(0);
        (await app.RefreshRawAsync(login.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.OK, "o refresh comum segue valendo");
    }

    [Fact]
    public async Task Challenge_InsideTheThreeSecondTolerance_Returns409WithoutRevoking()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var device = new TestDevice();
        var login = await app.LoginAsync(device: device);
        (await app.RefreshRawAsync(login.RefreshSecret)).Dispose();
        app.Time.Advance(TimeSpan.FromSeconds(2));

        using var response = await app.ChallengeRawAsync(login.RefreshSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        await using var db = app.Db();
        (await db.RefreshTokens.CountAsync(t => t.RevokedAt != null, Ct)).Should().Be(0);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("lixo")]
    public async Task Challenge_WithMissingOrUnknownCookie_Returns401(string? secret)
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var response = await app.ChallengeRawAsync(secret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Challenge_WithoutTheClientHeader_Returns400()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var device = new TestDevice();
        var login = await app.LoginAsync(device: device);

        using var response = await app.ChallengeRawAsync(login.RefreshSecret, clientHeader: false);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Challenge_AfterLogout_Returns401()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var device = new TestDevice();
        var login = await app.LoginAsync(device: device);
        (await app.RefreshRawAsync(login.RefreshSecret)).Dispose();
        (await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: login.AccessToken)).Dispose();
        app.Time.Advance(TimeSpan.FromSeconds(30));

        using var response = await app.ChallengeRawAsync(login.RefreshSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await using var db = app.Db();
        (await db.RefreshRecoveryChallenges.CountAsync(Ct)).Should().Be(0, "sessão encerrada não ganha desafio");
    }

    [Fact]
    public async Task Recovery_DoesNotRevive_ASessionThatWasLoggedOutAfterTheLostResponse()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        (await scene.App.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: scene.Login.AccessToken)).Dispose();

        using var response = await scene.App.ChallengeRawAsync(scene.OldSecret);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Logout_WhileARecoveryIsRotating_LeavesNoActiveToken()
    {
        await using var scene = await LostResponse.StartAsync(postgres);
        var app = scene.App;
        var (challenge, family) = await app.ChallengeAsync(scene.OldSecret);
        var proof = scene.Device.Sign(family, challenge);
        await RotationHold.InstallAsync(app);

        var recovery = app.RefreshWithProofAsync(scene.OldSecret, challenge, proof);
        await RotationHold.WaitUntilPausedAsync(app);
        var logout = app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: scene.Login.AccessToken);

        using var recovered = await recovery;
        using var loggedOut = await logout;

        recovered.StatusCode.Should().Be(HttpStatusCode.OK);
        loggedOut.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        (await db.RefreshTokens.AsNoTracking().ToListAsync(Ct)).Should().HaveCount(3)
            .And.OnlyContain(t => t.RevokedAt != null, "o sucessor da recuperação foi revogado pelo Sair");
        var successor = IdentityApp.Cookies(recovered).Single(c => c.Name == "uo_rt").Value;
        (await app.RefreshRawAsync(successor)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
