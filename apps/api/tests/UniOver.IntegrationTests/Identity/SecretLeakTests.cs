using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class SecretLeakTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task NoLogLineCarriesAPassword_AToken_ARefreshSecretOrTheHash()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var wrongPassword = "errada-" + Guid.NewGuid().ToString("N");

        // Todos os caminhos que mexem em segredo: login ruim, login bom, refresh, reuso, ticket, logout.
        (await app.LoginRawAsync(app.OwnerEmail, wrongPassword)).Dispose();
        (await app.LoginRawAsync("ninguem@uniover.test", wrongPassword)).Dispose();
        var login = await app.LoginAsync();
        using var rotated = await app.RefreshRawAsync(login.RefreshSecret);
        var secondSecret = IdentityApp.Cookies(rotated).Single().Value;
        app.Time.Advance(TimeSpan.FromSeconds(10));
        (await app.RefreshRawAsync(login.RefreshSecret)).Dispose();
        var fresh = await app.LoginAsync();
        (await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: fresh.AccessToken)).Dispose();
        (await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: fresh.AccessToken)).Dispose();
        (await app.GetAsync("/api/v1/identity/me?access_token=" + fresh.AccessToken)).Dispose();

        string hash;
        await using (var db = app.Db())
        {
            hash = (await db.Users.SingleAsync(Ct)).PasswordHash;
        }

        var secrets = new[]
        {
            app.OwnerPassword, wrongPassword, login.AccessToken, login.RefreshSecret, secondSecret, fresh.AccessToken,
            fresh.RefreshSecret, hash, app.SigningKey,
        };
        var lines = app.Logs.Lines;
        lines.Should().NotBeEmpty();
        foreach (var secret in secrets)
        {
            lines.Should().NotContain(l => l.Contains(secret, StringComparison.Ordinal), "segredo nenhum pode ir para o log");
        }
    }
}
