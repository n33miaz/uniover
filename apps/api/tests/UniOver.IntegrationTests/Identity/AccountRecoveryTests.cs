using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.Totp;
using UniOver.Modules.Identity.Security;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class AccountRecoveryTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task RequestKeepsAccountsIndistinguishableWhenDeliveryIsOff()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        using var availability = await app.SendAsync(HttpMethod.Get,
            "/api/v1/identity/auth/password/recovery/availability");
        Assert.Equal(HttpStatusCode.OK, availability.StatusCode);
        using var status = JsonDocument.Parse(await availability.Content.ReadAsStringAsync(Ct));
        Assert.False(status.RootElement.GetProperty("enabled").GetBoolean());
        var login = await app.LoginAsync();
        using var totp = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me/totp",
            bearer: login.AccessToken);
        var factor = await totp.Content.ReadFromJsonAsync<TotpStatusResponse>(Ct);
        Assert.False(factor!.Available);
        using var known = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/password/recovery",
            new { email = app.OwnerEmail });
        using var unknown = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/password/recovery",
            new { email = "unknown@uniover.test" });
        Assert.Equal(HttpStatusCode.Accepted, known.StatusCode);
        Assert.Equal(known.StatusCode, unknown.StatusCode);
        await using var db = app.Db();
        Assert.Empty(await db.PasswordResetTokens.ToListAsync(Ct));
    }

    [Fact]
    public async Task ResetConsumesLinkAndRevokesExistingSession()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var old = await app.LoginAsync();
        var (token, hash) = SecretTokens.Generate();
        await using (var db = app.Db())
        {
            var user = await db.Users.SingleAsync(Ct);
            db.PasswordResetTokens.Add(PasswordResetToken.Create(user.Id, hash, app.Time.GetUtcNow()));
            await db.SaveChangesAsync(Ct);
        }

        var password = IdentityApp.NewPassword();
        using var changed = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/password/reset",
            new { token, newPassword = password });
        Assert.Equal(HttpStatusCode.NoContent, changed.StatusCode);
        using var repeated = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/password/reset",
            new { token, newPassword = IdentityApp.NewPassword() });
        Assert.Equal(HttpStatusCode.BadRequest, repeated.StatusCode);
        using var oldLogin = await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword);
        Assert.Equal(HttpStatusCode.Unauthorized, oldLogin.StatusCode);
        using var newLogin = await app.LoginRawAsync(app.OwnerEmail, password);
        Assert.Equal(HttpStatusCode.OK, newLogin.StatusCode);
        await using var check = app.Db();
        Assert.True(await check.RefreshTokens.AnyAsync(t => t.TokenHash == SecretTokens.Hash(old.RefreshSecret) &&
            t.RevokedReason == RevokeReasons.PasswordReset, Ct));
    }

    [Fact]
    public async Task ActiveTotpBlocksPasswordOnlyLoginAndReusedStep()
    {
        var key = IdentityApp.NewKey();
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions
        {
            Extra = new Dictionary<string, string?> { ["Modules:Identity:TotpKey"] = key },
        });
        var secret = TotpCodes.NewSecret();
        var code = TotpCodes.AtStep(secret, app.Time.GetUtcNow().ToUnixTimeSeconds() / 30);
        await using (var db = app.Db())
        {
            var user = await db.Users.SingleAsync(Ct);
            var protector = new TotpSecretProtector(Convert.FromBase64String(key));
            var factor = TotpFactor.Pending(user.Id, protector.Protect(user.Id, secret), app.Time.GetUtcNow());
            factor.Activate(-1, app.Time.GetUtcNow());
            db.TotpFactors.Add(factor);
            await db.SaveChangesAsync(Ct);
        }

        using var required = await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword);
        Assert.Equal(HttpStatusCode.PreconditionRequired, required.StatusCode);
        Assert.Empty(IdentityApp.Cookies(required));
        using var valid = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/login",
            new { email = app.OwnerEmail, password = app.OwnerPassword, totpCode = code });
        Assert.Equal(HttpStatusCode.OK, valid.StatusCode);
        using var reused = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/login",
            new { email = app.OwnerEmail, password = app.OwnerPassword, totpCode = code });
        Assert.Equal(HttpStatusCode.Unauthorized, reused.StatusCode);
    }

    [Fact]
    public async Task EnrollmentRequiresRecentStepUpAndShowsRecoveryCodesOnce()
    {
        var key = IdentityApp.NewKey();
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions
        {
            Extra = new Dictionary<string, string?> { ["Modules:Identity:TotpKey"] = key },
        });
        var login = await app.LoginAsync();
        using var before = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me/totp",
            bearer: login.AccessToken);
        Assert.Equal(HttpStatusCode.OK, before.StatusCode);
        var initial = await before.Content.ReadFromJsonAsync<TotpStatusResponse>(Ct);
        Assert.True(initial!.Available);
        Assert.False(initial!.Active);
        Assert.Equal(0, initial.RecoveryCodesRemaining);
        using var denied = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/me/totp/start",
            new { password = app.OwnerPassword }, bearer: login.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);

        var session = Guid.Parse(new JsonWebTokenHandler().ReadJsonWebToken(login.AccessToken).GetClaim("sid").Value);
        Guid userId;
        await using (var db = app.Db())
        {
            var user = await db.Users.SingleAsync(Ct);
            userId = user.Id;
            db.StepUpConfirmations.Add(StepUpConfirmation.Create(
                userId, session, StepUpActions.FactorManage, app.Time.GetUtcNow(), TimeSpan.FromMinutes(5)));
            await db.SaveChangesAsync(Ct);
        }

        using var started = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/me/totp/start",
            new { password = app.OwnerPassword }, bearer: login.AccessToken);
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        var provision = await started.Content.ReadFromJsonAsync<StartTotpResponse>(Ct);
        Assert.StartsWith("otpauth://totp/", provision!.ProvisioningUri);
        string code;
        await using (var db = app.Db())
        {
            var factor = await db.TotpFactors.SingleAsync(Ct);
            var secret = new TotpSecretProtector(Convert.FromBase64String(key)).Unprotect(userId, factor.EncryptedSecret);
            code = TotpCodes.AtStep(secret, app.Time.GetUtcNow().ToUnixTimeSeconds() / 30);
        }
        using var activated = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/me/totp/confirm",
            new { code }, bearer: login.AccessToken);
        Assert.Equal(HttpStatusCode.OK, activated.StatusCode);
        var codes = await activated.Content.ReadFromJsonAsync<ConfirmTotpResponse>(Ct);
        Assert.Equal(10, codes!.RecoveryCodes.Distinct().Count());
        using var after = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me/totp",
            bearer: login.AccessToken);
        var status = await after.Content.ReadFromJsonAsync<TotpStatusResponse>(Ct);
        Assert.True(status!.Active);
        Assert.Equal(10, status.RecoveryCodesRemaining);
        using var repeated = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/me/totp/confirm",
            new { code }, bearer: login.AccessToken);
        Assert.Equal(HttpStatusCode.BadRequest, repeated.StatusCode);
        using var passwordOnly = await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword);
        Assert.Equal(HttpStatusCode.PreconditionRequired, passwordOnly.StatusCode);
    }

    [Fact]
    public async Task RecoveryCodeRequiresStepUpAndRevokesTheSessionAfterUse()
    {
        var key = IdentityApp.NewKey();
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions
        {
            Extra = new Dictionary<string, string?> { ["Modules:Identity:TotpKey"] = key },
        });
        var login = await app.LoginAsync();
        var session = Guid.Parse(new JsonWebTokenHandler().ReadJsonWebToken(login.AccessToken).GetClaim("sid").Value);
        var (code, hash) = RecoveryCodes.Generate();
        await using (var db = app.Db())
        {
            var user = await db.Users.SingleAsync(Ct);
            var secret = TotpCodes.NewSecret();
            var factor = TotpFactor.Pending(user.Id,
                new TotpSecretProtector(Convert.FromBase64String(key)).Protect(user.Id, secret), app.Time.GetUtcNow());
            factor.Activate(-1, app.Time.GetUtcNow());
            db.TotpFactors.Add(factor);
            db.AccountRecoveryCodes.Add(AccountRecoveryCode.Create(user.Id, hash, app.Time.GetUtcNow()));
            await db.SaveChangesAsync(Ct);
        }

        var password = IdentityApp.NewPassword();
        using var denied = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/me/password/recover-with-code",
            new { recoveryCode = code, newPassword = password }, bearer: login.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        using (var details = JsonDocument.Parse(await denied.Content.ReadAsStringAsync(Ct)))
            Assert.Equal(StepUpActions.PasswordRecovery, details.RootElement.GetProperty("action").GetString());

        await using (var db = app.Db())
        {
            var user = await db.Users.SingleAsync(Ct);
            db.StepUpConfirmations.Add(StepUpConfirmation.Create(user.Id, session,
                StepUpActions.PasswordRecovery, app.Time.GetUtcNow(), TimeSpan.FromMinutes(5)));
            await db.SaveChangesAsync(Ct);
        }
        using var changed = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/me/password/recover-with-code",
            new { recoveryCode = code, newPassword = password }, bearer: login.AccessToken);
        Assert.Equal(HttpStatusCode.NoContent, changed.StatusCode);
        using var old = await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword);
        Assert.Equal(HttpStatusCode.Unauthorized, old.StatusCode);
        using var fresh = await app.LoginRawAsync(app.OwnerEmail, password);
        Assert.Equal(HttpStatusCode.PreconditionRequired, fresh.StatusCode);
        await using var check = app.Db();
        Assert.NotNull((await check.AccountRecoveryCodes.SingleAsync(Ct)).UsedAt);
    }

    [Fact]
    public async Task ExpiredLinkIsRejectedAndConcurrentUseSucceedsOnce()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var (expired, expiredHash) = SecretTokens.Generate();
        var (fresh, freshHash) = SecretTokens.Generate();
        await using (var db = app.Db())
        {
            var user = await db.Users.SingleAsync(Ct);
            db.PasswordResetTokens.Add(PasswordResetToken.Create(user.Id, expiredHash,
                app.Time.GetUtcNow().AddMinutes(-21)));
            db.PasswordResetTokens.Add(PasswordResetToken.Create(user.Id, freshHash, app.Time.GetUtcNow()));
            await db.SaveChangesAsync(Ct);
        }
        using var stale = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/password/reset",
            new { token = expired, newPassword = IdentityApp.NewPassword() });
        Assert.Equal(HttpStatusCode.BadRequest, stale.StatusCode);

        var first = app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/password/reset",
            new { token = fresh, newPassword = IdentityApp.NewPassword() });
        var second = app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/password/reset",
            new { token = fresh, newPassword = IdentityApp.NewPassword() });
        using var a = await first;
        using var b = await second;
        Assert.Equal(1, new[] { a.StatusCode, b.StatusCode }.Count(s => s == HttpStatusCode.NoContent));
        Assert.Equal(1, new[] { a.StatusCode, b.StatusCode }.Count(s => s == HttpStatusCode.BadRequest));
    }
}
