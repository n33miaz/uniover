using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Identity;

/// <summary>Sair e revogar uma sessão passam pela mesma trava da família que o refresh: nunca sobra um sucessor ativo.</summary>
[Collection(PostgresGroup.Name)]
public sealed class FamilyLockTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Logout_WhileARefreshIsRotating_LeavesNoActiveToken()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        await RotationHold.InstallAsync(app);

        var rotation = app.RefreshRawAsync(login.RefreshSecret);
        await RotationHold.WaitUntilPausedAsync(app);
        var logout = app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: login.AccessToken);

        using var rotated = await rotation;
        using var loggedOut = await logout;

        rotated.StatusCode.Should().Be(HttpStatusCode.OK);
        loggedOut.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        (await db.RefreshTokens.AsNoTracking().ToListAsync(Ct)).Should().HaveCount(2)
            .And.OnlyContain(t => t.RevokedAt != null, "o sucessor nasceu antes do Sair e foi revogado por ele");
        var successor = IdentityApp.Cookies(rotated).Single(c => c.Name == "uo_rt").Value;
        (await app.RefreshRawAsync(successor)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task SessionRevocation_WhileARefreshIsRotating_LeavesNoActiveTokenInThatFamily()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var target = await app.LoginAsync();
        var other = await app.LoginAsync();
        var targetFamily = new JsonWebTokenHandler().ReadJsonWebToken(target.AccessToken).GetClaim("sid").Value;
        await RotationHold.InstallAsync(app);

        var rotation = app.RefreshRawAsync(target.RefreshSecret);
        await RotationHold.WaitUntilPausedAsync(app);
        var revoke = app.SendAsync(HttpMethod.Post, $"/api/v1/identity/sessions/{targetFamily}/revoke", bearer: other.AccessToken);

        using var rotated = await rotation;
        using var revoked = await revoke;

        rotated.StatusCode.Should().Be(HttpStatusCode.OK);
        revoked.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        var family = Guid.Parse(targetFamily);
        (await db.RefreshTokens.AsNoTracking().Where(t => t.FamilyId == family).ToListAsync(Ct))
            .Should().HaveCount(2).And.OnlyContain(t => t.RevokedAt != null);
    }
}
