using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class ChangePasswordTests(PostgresFixture postgres)
{
    private const string Route = "/api/v1/identity/me/password";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Task<HttpResponseMessage> ChangeAsync(IdentityApp app, string? access, string? current, string? next) =>
        app.SendAsync(HttpMethod.Post, Route, new { currentPassword = current, newPassword = next }, bearer: access);

    [Fact]
    public async Task ChangePreservesCurrentSession_RevokesOthersAndOldPassword_AndClearsConfirmations()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var other = await app.LoginAsync();
        var current = await app.LoginAsync();
        var newPassword = IdentityApp.NewPassword();
        var sessionId = Guid.Parse(new JsonWebTokenHandler().ReadJsonWebToken(current.AccessToken).GetClaim("sid").Value);

        await using (var db = app.Db())
        {
            var userId = await db.RefreshTokens.Where(t => t.FamilyId == sessionId).Select(t => t.UserId).SingleAsync(Ct);
            db.StepUpConfirmations.Add(StepUpConfirmation.Create(
                userId, sessionId, StepUpActions.PermissionsChange, app.Time.GetUtcNow(), TimeSpan.FromMinutes(5)));
            await db.SaveChangesAsync(Ct);
        }

        using var changed = await ChangeAsync(app, current.AccessToken, app.OwnerPassword, newPassword);
        changed.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using (var verifyRevocation = app.Db())
        {
            (await verifyRevocation.RefreshTokens.Where(t => t.FamilyId != sessionId)
                .AnyAsync(t => t.RevokedReason == RevokeReasons.PasswordChanged, Ct)).Should().BeTrue();
        }
        (await app.RefreshRawAsync(other.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await app.RefreshRawAsync(current.RefreshSecret)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await app.LoginRawAsync(app.OwnerEmail, newPassword)).StatusCode.Should().Be(HttpStatusCode.OK);

        await using var verify = app.Db();
        (await verify.StepUpConfirmations.CountAsync(Ct)).Should().Be(0);
        (await verify.LoginAudit.CountAsync(a => a.Event == AuditEvents.PasswordChanged, Ct)).Should().Be(1);
        (await verify.LoginAudit.Where(a => a.Event == AuditEvents.PasswordChanged)
            .Select(a => a.Detail).SingleAsync(Ct)).Should().BeNull();
        app.Logs.Lines.Should().NotContain(line => line.Contains(app.OwnerPassword, StringComparison.Ordinal));
        app.Logs.Lines.Should().NotContain(line => line.Contains(newPassword, StringComparison.Ordinal));
    }

    [Fact]
    public async Task WrongCurrentPasswordIsRateCounted_AndDoesNotChangeCredentials()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var current = await app.LoginAsync();
        var newPassword = IdentityApp.NewPassword();

        using var wrong = await ChangeAsync(app, current.AccessToken, "senha-errada-123", newPassword);
        wrong.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await IdentityApp.JsonAsync(wrong)).GetProperty("type").GetString().Should().EndWith("invalid-password");
        (await app.LoginRawAsync(app.OwnerEmail, newPassword)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword)).StatusCode.Should().Be(HttpStatusCode.OK);

        await using var db = app.Db();
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.PasswordChangeFailed, Ct)).Should().Be(1);
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.PasswordChanged, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task GuestCanChangeOnlyItsOwnPassword_AndMalformedInputDoesNotConsumeTheCurrentOne()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var next = IdentityApp.NewPassword();

        using var shortPassword = await ChangeAsync(app, guest.Login.AccessToken, guest.Password, "curta");
        shortPassword.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var samePassword = await ChangeAsync(app, guest.Login.AccessToken, guest.Password, guest.Password);
        samePassword.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var changed = await ChangeAsync(app, guest.Login.AccessToken, guest.Password, next);
        changed.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await app.LoginRawAsync(guest.Email, guest.Password)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await app.LoginRawAsync(guest.Email, next)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword)).StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
