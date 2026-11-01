using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using UniOver.IntegrationTests.Audit;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Identity;

/// <summary>
/// O que o dono lê em Pessoas sobre a Início de cada um: a lista guardada (personalizou), "padrão" (já abriu a versão que
/// sincroniza e nunca mexeu) ou "sem dados" (nunca abriu depois dela). Só o dono vê isso de outras pessoas.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class PeopleHomeTests(PostgresFixture postgres)
{
    private const string Route = "/api/v1/identity/people-usage";
    private const string Preferences = "/api/v1/identity/me/preferences";

    private static JsonElement HomeOf(JsonElement list, Guid id) =>
        list.EnumerateArray().Single(p => p.GetProperty("id").GetGuid() == id).GetProperty("home");

    private static string State(JsonElement home) => home.GetProperty("state").GetString()!;

    [Fact]
    public async Task OwnerSeesEachPersonsHome_AsCustomDefaultOrUnknown()
    {
        var (database, _) = await AuditKit.MigrateEverythingAsync(postgres);
        await using var app = await AuditKit.StartAppAsync(postgres, database);
        var owner = await app.LoginAsync();
        var ownerId = await AuditKit.OwnerIdAsync(app);
        var now = app.Time.GetUtcNow();

        // Raphael: abriu o app novo (o aparelho foi informado no aceite) e personalizou só com o Treino.
        var (_, raphaelInvite) = await GuestSeed.InsertInviteAsync(database, now, "Raphael");
        using var accept = await app.SendAsync(
            HttpMethod.Post, GuestSeed.AcceptRoute,
            new { token = raphaelInvite, email = GuestSeed.NewEmail(), password = GuestSeed.NewPassword() },
            extraHeaders: new Dictionary<string, string> { ["X-UniOver-Client-Env"] = "iphone;browser" });
        var raphael = await GuestSeed.ReadLoginAsync(accept);
        var raphaelId = Guid.Parse(new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().ReadJsonWebToken(raphael.AccessToken).Subject);
        using var save = await app.SendAsync(
            HttpMethod.Put, Preferences,
            new { baseVersion = 0, home = new[] { new { id = "training", enabled = true }, new { id = "tv", enabled = false } } },
            bearer: raphael.AccessToken);
        save.StatusCode.Should().Be(HttpStatusCode.OK);

        // Bia: abriu o app novo e nunca personalizou. Caio: só tem a entrada de um app antigo (sem o aparelho informado).
        var bia = await GuestSeed.CreateGuestAsync(app.Client, database, now, "Bia");
        using var biaEnv = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/login", new { email = bia.Email, password = bia.Password },
            extraHeaders: new Dictionary<string, string> { ["X-UniOver-Client-Env"] = "android;standalone" });
        biaEnv.StatusCode.Should().Be(HttpStatusCode.OK);
        var caio = await GuestSeed.CreateGuestAsync(app.Client, database, now, "Caio");

        using var response = await app.GetAsync(Route, owner.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var people = await IdentityApp.JsonAsync(response);

        var raphaelHome = HomeOf(people, raphaelId);
        State(raphaelHome).Should().Be("custom");
        raphaelHome.GetProperty("entries").EnumerateArray()
            .Select(e => (e.GetProperty("id").GetString(), e.GetProperty("enabled").GetBoolean()))
            .Should().Equal(("training", true), ("tv", false));
        State(HomeOf(people, bia.UserId)).Should().Be("default");
        HomeOf(people, bia.UserId).GetProperty("entries").GetArrayLength().Should().Be(0);
        State(HomeOf(people, caio.UserId)).Should().Be("unknown");
        State(HomeOf(people, ownerId)).Should().Be("unknown", "o login do dono nesta suíte veio sem o aparelho informado");
    }

    [Fact]
    public async Task OwnerWhoOpenedTheNewApp_IsDefault_UntilTheyPersonalize()
    {
        var (database, _) = await AuditKit.MigrateEverythingAsync(postgres);
        await using var app = await AuditKit.StartAppAsync(postgres, database);
        var ownerId = await AuditKit.OwnerIdAsync(app);
        using var login = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/login", new { email = app.OwnerEmail, password = app.OwnerPassword },
            extraHeaders: new Dictionary<string, string> { ["X-UniOver-Client-Env"] = "pc;browser" });
        var owner = await GuestSeed.ReadLoginAsync(login);

        using var before = await app.GetAsync(Route, owner.AccessToken);
        State(HomeOf(await IdentityApp.JsonAsync(before), ownerId)).Should().Be("default");

        using var save = await app.SendAsync(
            HttpMethod.Put, Preferences,
            new { baseVersion = 0, home = new[] { new { id = "tv", enabled = true } } }, bearer: owner.AccessToken);
        save.StatusCode.Should().Be(HttpStatusCode.OK);
        using var after = await app.GetAsync(Route, owner.AccessToken);
        State(HomeOf(await IdentityApp.JsonAsync(after), ownerId)).Should().Be("custom");
    }

    [Fact]
    public async Task AGuestCannotSeeAnyoneElsesHome_AndAnonymousCannotEither()
    {
        var (database, _) = await AuditKit.MigrateEverythingAsync(postgres);
        await using var app = await AuditKit.StartAppAsync(postgres, database);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, database, app.Time.GetUtcNow());

        using var asGuest = await app.GetAsync(Route, guest.Login.AccessToken);
        using var anonymous = await app.GetAsync(Route);

        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
