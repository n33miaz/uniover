using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Identity;

/// <summary>
/// As preferências da própria conta (a Início): só o dono da conta lê e grava as suas, a versão impede que um aparelho
/// apague a mudança mais nova de outro, e o formato aceito é fechado. Host real, Postgres real.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class PreferencesTests(PostgresFixture postgres)
{
    private const string Route = "/api/v1/identity/me/preferences";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static object[] Home(params (string Id, bool Enabled)[] entries) =>
        [.. entries.Select(e => new { id = e.Id, enabled = e.Enabled })];

    private static Task<HttpResponseMessage> PutAsync(IdentityApp app, string token, object? body) =>
        app.SendAsync(HttpMethod.Put, Route, body, bearer: token);

    [Fact]
    public async Task Anonymous_IsRefused_OnReadAndWrite()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var read = await app.GetAsync(Route);
        using var write = await app.SendAsync(HttpMethod.Put, Route, new { baseVersion = 0, home = Home(("tv", true)) });

        read.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        write.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task AccountWithoutAnySave_ReadsTheDefault_AtVersionZero()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await app.GetAsync(Route, owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(response);
        body.GetProperty("version").GetInt32().Should().Be(0);
        body.GetProperty("home").ValueKind.Should().Be(JsonValueKind.Null);
        body.GetProperty("updatedAt").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task Save_KeepsTheOrderAndVisibility_AndBumpsTheVersion()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var first = await PutAsync(app, owner.AccessToken, new { baseVersion = 0, home = Home(("training", true), ("tv", false)) });
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        var saved = await IdentityApp.JsonAsync(first);
        saved.GetProperty("version").GetInt32().Should().Be(1);
        saved.GetProperty("updatedAt").GetDateTimeOffset().Should().Be(app.Time.GetUtcNow());

        app.Time.Advance(TimeSpan.FromMinutes(5));
        using var second = await PutAsync(app, owner.AccessToken, new { baseVersion = 1, home = Home(("tv", true), ("training", true)) });
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        (await IdentityApp.JsonAsync(second)).GetProperty("version").GetInt32().Should().Be(2);

        using var read = await app.GetAsync(Route, owner.AccessToken);
        var body = await IdentityApp.JsonAsync(read);
        body.GetProperty("version").GetInt32().Should().Be(2);
        body.GetProperty("updatedAt").GetDateTimeOffset().Should().Be(app.Time.GetUtcNow());
        body.GetProperty("home").EnumerateArray().Select(e => (e.GetProperty("id").GetString(), e.GetProperty("enabled").GetBoolean()))
            .Should().Equal(("tv", true), ("training", true));
    }

    [Fact]
    public async Task StaleVersion_IsRefused_WithTheNewerAccount_AndNothingIsOverwritten()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var a1 = await PutAsync(app, owner.AccessToken, new { baseVersion = 0, home = Home(("tv", true)) });
        a1.StatusCode.Should().Be(HttpStatusCode.OK);

        // Um segundo aparelho leu a versão 1 e gravou antes; o primeiro ainda acha que está na 1.
        using var phoneB = await PutAsync(app, owner.AccessToken, new { baseVersion = 1, home = Home(("training", true), ("tv", true)) });
        phoneB.StatusCode.Should().Be(HttpStatusCode.OK);
        using var phoneA = await PutAsync(app, owner.AccessToken, new { baseVersion = 1, home = Home(("tv", false)) });

        phoneA.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var current = await IdentityApp.JsonAsync(phoneA);
        current.GetProperty("version").GetInt32().Should().Be(2, "a recusa devolve a conta como ela está");
        current.GetProperty("home").EnumerateArray().Select(e => e.GetProperty("id").GetString()).Should().Equal("training", "tv");

        await using var db = app.Db();
        var row = await db.AccountPreferences.SingleAsync(Ct);
        row.Version.Should().Be(2);
        row.HomeJson.Should().Contain("training");
    }

    [Fact]
    public async Task FirstSaveFromSeveralDevicesAtOnce_HasOneWinner()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        var results = await Task.WhenAll(
            Enumerable.Range(0, 4).Select(async i =>
            {
                using var response = await PutAsync(app, owner.AccessToken, new { baseVersion = 0, home = Home(($"mod-{i}", true)) });
                return response.StatusCode;
            }));

        results.Count(s => s == HttpStatusCode.OK).Should().Be(1);
        results.Count(s => s == HttpStatusCode.Conflict).Should().Be(3);
        await using var db = app.Db();
        (await db.AccountPreferences.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task AGuest_ReadsAndWritesOnlyTheirOwn_NeverTheOwners()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var ownerSave = await PutAsync(app, owner.AccessToken, new { baseVersion = 0, home = Home(("tv", true)) });
        ownerSave.StatusCode.Should().Be(HttpStatusCode.OK);

        // A rota não recebe id de conta: o convidado só enxerga a própria linha, ainda vazia.
        using var guestRead = await app.GetAsync(Route, guest.Login.AccessToken);
        (await IdentityApp.JsonAsync(guestRead)).GetProperty("version").GetInt32().Should().Be(0);

        // Gravar na versão do dono (1) não alcança a linha do dono: a do convidado nem existe, então é conflito.
        using var cross = await PutAsync(app, guest.Login.AccessToken, new { baseVersion = 1, home = Home(("training", true)) });
        cross.StatusCode.Should().Be(HttpStatusCode.Conflict);
        using var own = await PutAsync(app, guest.Login.AccessToken, new { baseVersion = 0, home = Home(("training", true)) });
        own.StatusCode.Should().Be(HttpStatusCode.OK);

        using var ownerRead = await app.GetAsync(Route, owner.AccessToken);
        var ownerHome = (await IdentityApp.JsonAsync(ownerRead)).GetProperty("home");
        ownerHome.EnumerateArray().Select(e => e.GetProperty("id").GetString()).Should().Equal("tv");
    }

    [Fact]
    public async Task ARevokedGuest_CannotWrite_ButTheOwnerIsNotAffected()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke", bearer: owner.AccessToken);
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var write = await PutAsync(app, guest.Login.AccessToken, new { baseVersion = 0, home = Home(("tv", true)) });
        using var ownerWrite = await PutAsync(app, owner.AccessToken, new { baseVersion = 0, home = Home(("tv", true)) });

        write.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        ownerWrite.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task NullHome_GoesBackToTheDefault_AndBumpsTheVersion()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var save = await PutAsync(app, owner.AccessToken, new { baseVersion = 0, home = Home(("tv", true)) });
        save.StatusCode.Should().Be(HttpStatusCode.OK);

        using var reset = await PutAsync(app, owner.AccessToken, new { baseVersion = 1, home = (object?)null });

        reset.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(reset);
        body.GetProperty("version").GetInt32().Should().Be(2);
        body.GetProperty("home").ValueKind.Should().Be(JsonValueKind.Null);
    }

    public static TheoryData<string, object?> InvalidBodies => new()
    {
        { "sem a versão", new { home = new[] { new { id = "tv", enabled = true } } } },
        { "versão negativa", new { baseVersion = -1, home = new[] { new { id = "tv", enabled = true } } } },
        { "id repetido", new { baseVersion = 0, home = new[] { new { id = "tv", enabled = true }, new { id = "tv", enabled = false } } } },
        { "id em maiúsculas", new { baseVersion = 0, home = new[] { new { id = "TV", enabled = true } } } },
        { "id com barra", new { baseVersion = 0, home = new[] { new { id = "tv/../x", enabled = true } } } },
        { "id vazio", new { baseVersion = 0, home = new[] { new { id = "", enabled = true } } } },
        { "id comprido demais", new { baseVersion = 0, home = new[] { new { id = new string('a', 41), enabled = true } } } },
        { "lista grande demais", new { baseVersion = 0, home = Enumerable.Range(0, 33).Select(i => new { id = $"m{i}", enabled = true }).ToArray() } },
    };

    [Theory]
    [MemberData(nameof(InvalidBodies))]
    public async Task InvalidBody_Is400_AndNothingIsStored(string reason, object? body)
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await PutAsync(app, owner.AccessToken, body);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest, reason);
        await using var db = app.Db();
        (await db.AccountPreferences.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task EmptyList_IsAValidChoice()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await PutAsync(app, owner.AccessToken, new { baseVersion = 0, home = Array.Empty<object>() });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await IdentityApp.JsonAsync(response)).GetProperty("home").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task DeletingTheAccount_TakesItsPreferencesAlong()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var save = await PutAsync(app, guest.Login.AccessToken, new { baseVersion = 0, home = Home(("tv", true)) });
        save.StatusCode.Should().Be(HttpStatusCode.OK);

        await using (var db = app.Db())
        {
            await db.Database.ExecuteSqlInterpolatedAsync($"DELETE FROM identity.users WHERE id = {guest.UserId}", Ct);
        }

        await using var check = app.Db();
        (await check.AccountPreferences.CountAsync(Ct)).Should().Be(0);
    }
}
