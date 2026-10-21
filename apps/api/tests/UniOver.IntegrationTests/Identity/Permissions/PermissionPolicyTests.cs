using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity.Permissions;

/// <summary>
/// O motor de autorização por permissão: o dono passa sempre; o convidado precisa da concessão LIDA DO BANCO (cache de
/// 30 s, invalidado ao mudar ou revogar); conta revogada, sem papel ou com papel inventado não passa. As rotas de teste
/// usam a política como a TV e o Treino vão usar, só pelo helper do BuildingBlocks.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class PermissionPolicyTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly string[] AllRoutes =
        [PasskeyApp.TvControlRoute, PasskeyApp.TvEditShortcutsRoute, PasskeyApp.TrainingRoute];

    private async Task<(PasskeyApp App, LoggedIn Owner, VirtualAuthenticator Authenticator)> StartOwnerAsync()
    {
        var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);
        return (app, owner, authenticator);
    }

    private static async Task<HttpStatusCode> StatusAsync(PasskeyApp app, string url, string? bearer)
    {
        using var response = await app.SendAsync(HttpMethod.Get, url, bearer: bearer);
        return response.StatusCode;
    }

    private static async Task<HttpStatusCode> PutAsync(
        PasskeyApp app, LoggedIn owner, VirtualAuthenticator authenticator, Guid guestId, string[] permissions)
    {
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.PermissionsChange);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        using var response = await app.SendAsync(
            HttpMethod.Put, $"/api/v1/identity/guests/{guestId}/permissions", new { permissions }, owner.AccessToken);
        return response.StatusCode;
    }

    private static async Task ExecuteAsync(PasskeyApp app, string sql)
    {
        await using var db = app.Db();
        await db.Database.ExecuteSqlRawAsync(sql, Ct);
    }

    [Fact]
    public async Task Owner_PassesEveryPermissionPolicy_WithoutAnyGrantRow()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        foreach (var route in AllRoutes)
        {
            (await StatusAsync(app, route, owner.AccessToken)).Should().Be(HttpStatusCode.OK, route);
        }

        await using var db = app.Db();
        (await db.UserGrants.CountAsync(Ct)).Should().Be(0, "o dono tem tudo de forma implícita");
    }

    [Fact]
    public async Task Anonymous_Gets401_OnEveryPermissionPolicy()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);

        foreach (var route in AllRoutes)
        {
            (await StatusAsync(app, route, null)).Should().Be(HttpStatusCode.Unauthorized, route);
        }
    }

    [Fact]
    public async Task Guest_PassesOnlyWhatWasGranted_AndEveryOtherPermissionIsDeniedByDefault()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var token = guest.Login.AccessToken;

        (await StatusAsync(app, PasskeyApp.TvControlRoute, token)).Should().Be(HttpStatusCode.OK);
        (await StatusAsync(app, PasskeyApp.TvEditShortcutsRoute, token)).Should().Be(HttpStatusCode.Forbidden, "hoje o convidado não edita atalhos");
        (await StatusAsync(app, PasskeyApp.TrainingRoute, token)).Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task ATrainingOnlyGuest_ReachesTrainingAndNothingOfTheTv()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Raphael", ["module:training"]);
        var token = guest.Login.AccessToken;

        (await StatusAsync(app, PasskeyApp.TrainingRoute, token)).Should().Be(HttpStatusCode.OK);
        (await StatusAsync(app, PasskeyApp.TvControlRoute, token)).Should().Be(HttpStatusCode.Forbidden);
        (await StatusAsync(app, PasskeyApp.TvEditShortcutsRoute, token)).Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task AChangeMadeThroughTheApi_TakesEffectAtOnce_WithTheSameJwt()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var token = guest.Login.AccessToken;
        (await StatusAsync(app, PasskeyApp.TvControlRoute, token)).Should().Be(HttpStatusCode.OK, "o cache já tem a conta");
        (await StatusAsync(app, PasskeyApp.TrainingRoute, token)).Should().Be(HttpStatusCode.Forbidden);

        (await PutAsync(app, owner, authenticator, guest.UserId, ["module:training"])).Should().Be(HttpStatusCode.OK);

        (await StatusAsync(app, PasskeyApp.TvControlRoute, token)).Should().Be(HttpStatusCode.Forbidden, "a permissão foi retirada e o cache esquecido");
        (await StatusAsync(app, PasskeyApp.TrainingRoute, token)).Should().Be(HttpStatusCode.OK, "a nova permissão vale sem esperar o prazo");
    }

    [Fact]
    public async Task AChangeMadeBehindTheCache_IsSeenWithin30Seconds_NotBefore()
    {
        // Simula outra instância: o banco muda sem passar pela invalidação desta.
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var token = guest.Login.AccessToken;
        (await StatusAsync(app, PasskeyApp.TvControlRoute, token)).Should().Be(HttpStatusCode.OK);

        await ExecuteAsync(app, $"DELETE FROM identity.user_grants WHERE user_id = '{guest.UserId}' AND permission <> 'module:tv'");
        await ExecuteAsync(app, $"INSERT INTO identity.user_grants (user_id, permission, granted_by, granted_at) VALUES ('{guest.UserId}', 'module:training', '{guest.UserId}', now())");

        app.Time.Advance(TimeSpan.FromSeconds(29));
        (await StatusAsync(app, PasskeyApp.TvControlRoute, token)).Should().Be(HttpStatusCode.OK, "dentro do prazo vale a resposta guardada");
        (await StatusAsync(app, PasskeyApp.TrainingRoute, token)).Should().Be(HttpStatusCode.Forbidden);

        app.Time.Advance(TimeSpan.FromSeconds(2));
        (await StatusAsync(app, PasskeyApp.TvControlRoute, token)).Should().Be(HttpStatusCode.Forbidden, "passados 30 s o banco é lido de novo");
        (await StatusAsync(app, PasskeyApp.TrainingRoute, token)).Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task RevokingTheGuest_StopsTheGrantsAtOnce_EvenWithTheJwtStillValid()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var grants = app.Services.GetRequiredService<IAccessGrants>();
        (await grants.HasAsync(guest.UserId, AccessPermissions.TvControl, Ct)).Should().BeTrue();

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke", bearer: owner.AccessToken);

        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await grants.HasAsync(guest.UserId, AccessPermissions.TvControl, Ct)).Should().BeFalse("o cache foi esquecido e a conta está revogada");
        (await grants.GetAsync(guest.UserId, Ct)).Should().BeEmpty();
        (await StatusAsync(app, PasskeyApp.TvControlRoute, guest.Login.AccessToken)).Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task ARevocationMadeBehindTheCache_IsSeenWithin30Seconds()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var grants = app.Services.GetRequiredService<IAccessGrants>();
        (await grants.HasAsync(guest.UserId, AccessPermissions.TvControl, Ct)).Should().BeTrue();

        await ExecuteAsync(app, $"UPDATE identity.users SET disabled_at = now() WHERE id = '{guest.UserId}'");

        app.Time.Advance(TimeSpan.FromSeconds(29));
        (await grants.HasAsync(guest.UserId, AccessPermissions.TvControl, Ct)).Should().BeTrue("ainda dentro do prazo do cache");
        app.Time.Advance(TimeSpan.FromSeconds(2));
        (await grants.HasAsync(guest.UserId, AccessPermissions.TvControl, Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task NoPermissionIsReadFromTheJwt_NotEvenFromATokenSignedWithTheRealKey()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Raphael", ["module:training"]);
        var now = app.Time.GetUtcNow();

        // Um token verdadeiro de convidado de Treino, só que com claims de permissão que ninguém emite: o servidor ignora todas.
        var token = IdentityApp.CraftToken(
            app.SigningKey,
            now.AddMinutes(-1),
            now.AddHours(1),
            subject: guest.UserId,
            role: AccountRoles.Guest,
            extraClaims: new Dictionary<string, object>
            {
                ["permissions"] = PermissionLists.ForgedByAnAttacker,
                ["permission"] = "tv:control",
                ["perms"] = "tv:control",
                ["scope"] = "tv:control module:tv",
            });

        (await StatusAsync(app, PasskeyApp.TvControlRoute, token)).Should().Be(HttpStatusCode.Forbidden);
        (await StatusAsync(app, PasskeyApp.TrainingRoute, token)).Should().Be(HttpStatusCode.OK, "a concessão do banco vale");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("admin")]
    [InlineData("Guest")]
    [InlineData("")]
    public async Task TokenWithoutRoleOrWithAnInventedRole_IsDenied_EvenForAnAccountThatHasGrants(string? role)
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var now = app.Time.GetUtcNow();
        var token = IdentityApp.CraftToken(app.SigningKey, now.AddMinutes(-1), now.AddHours(1), subject: guest.UserId, role: role);

        foreach (var route in AllRoutes)
        {
            (await StatusAsync(app, route, token)).Should().Be(HttpStatusCode.Forbidden, $"{route} com papel '{role ?? "(nenhum)"}'");
        }
    }

    [Fact]
    public async Task JwtOfAnAccountThatNoLongerExists_GetsNothing()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        var token = IdentityApp.CraftToken(app.SigningKey, now.AddMinutes(-1), now.AddHours(1), subject: Guid.NewGuid(), role: AccountRoles.Guest);

        foreach (var route in AllRoutes)
        {
            (await StatusAsync(app, route, token)).Should().Be(HttpStatusCode.Forbidden, route);
        }
    }

    [Fact]
    public async Task AnActionRowWithoutItsModule_GrantsNothing_EvenIfSomeoneEditedTheTableByHand()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        await ExecuteAsync(app, $"DELETE FROM identity.user_grants WHERE user_id = '{guest.UserId}' AND permission = 'module:tv'");
        var token = guest.Login.AccessToken;

        (await StatusAsync(app, PasskeyApp.TvControlRoute, token)).Should().Be(HttpStatusCode.Forbidden, "tv:control sem module:tv não vale");
        using var me = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: token);
        me.StatusCode.Should().Be(HttpStatusCode.OK);
        (await PasskeyApp.JsonAsync(me)).GetProperty("permissions").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task AGuestWithoutAnyGrantRow_HasNoAccessAtAll_ButStillSeesItsOwnProfile()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        await ExecuteAsync(app, $"DELETE FROM identity.user_grants WHERE user_id = '{guest.UserId}'");
        var token = guest.Login.AccessToken;

        foreach (var route in AllRoutes)
        {
            (await StatusAsync(app, route, token)).Should().Be(HttpStatusCode.Forbidden, route);
        }

        using var me = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: token);
        me.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task WhenTheGrantsCannotBeRead_TheAnswerIsDenied_NeverAnErrorOrAnAllow()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        await ExecuteAsync(app, "DROP TABLE identity.user_grants");

        (await StatusAsync(app, PasskeyApp.TvControlRoute, guest.Login.AccessToken)).Should().Be(HttpStatusCode.Forbidden, "falha fechada");
    }
}
