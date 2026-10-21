using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity.Permissions;

/// <summary>O que "quem sou" devolve (nome confirmado e permissões) e como a pessoa escolhe o próprio nome.</summary>
[Collection(PostgresGroup.Name)]
public sealed class ProfileTests(PostgresFixture postgres)
{
    private const string MeRoute = "/api/v1/identity/me";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Task<HttpResponseMessage> PatchAsync(PasskeyApp app, string? bearer, object? body) =>
        app.SendAsync(HttpMethod.Patch, MeRoute, body, bearer);

    private static async Task<JsonElement> GetMeAsync(PasskeyApp app, string bearer)
    {
        using var response = await app.SendAsync(HttpMethod.Get, MeRoute, bearer: bearer);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return await PasskeyApp.JsonAsync(response);
    }

    private static string[] Strings(JsonElement array) => [.. array.EnumerateArray().Select(e => e.GetString()!)];

    // ----- GET /me -----

    [Fact]
    public async Task Me_ForTheOwner_ListsEveryPermission_AndTheNameIsNotConfirmedYet()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        var me = await GetMeAsync(app, owner.AccessToken);

        me.GetProperty("role").GetString().Should().Be("owner");
        me.GetProperty("email").GetString().Should().Be(app.OwnerEmail);
        me.GetProperty("displayNameConfirmed").GetBoolean().Should().BeFalse("o dono ainda não escolheu o nome");
        Strings(me.GetProperty("permissions")).Should().Equal(AccessPermissions.All);
        me.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(
            ["id", "email", "displayName", "role", "displayNameConfirmed", "permissions"]);
    }

    [Fact]
    public async Task Me_ForAGuest_ListsOnlyWhatWasGranted()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Raphael", ["module:training"]);

        var me = await GetMeAsync(app, guest.Login.AccessToken);

        me.GetProperty("role").GetString().Should().Be("guest");
        me.GetProperty("displayName").GetString().Should().Be("Raphael");
        me.GetProperty("displayNameConfirmed").GetBoolean().Should().BeFalse("o nome veio do convite");
        Strings(me.GetProperty("permissions")).Should().Equal("module:training");
    }

    [Fact]
    public async Task Me_ForAGuest_NeverCarriesAnotherPersonsEmailOrName()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var get = await app.SendAsync(HttpMethod.Get, MeRoute, bearer: guest.Login.AccessToken);
        using var patch = await PatchAsync(app, guest.Login.AccessToken, new { displayName = "Alice Souza" });

        foreach (var response in new[] { get, patch })
        {
            var raw = await response.Content.ReadAsStringAsync(Ct);
            raw.Should().Contain(guest.Email).And.NotContain(app.OwnerEmail);
        }
    }

    [Fact]
    public async Task Me_ReflectsAPermissionChangeAtOnce_OnThisInstance()
    {
        var app = await PasskeyApp.StartAsync(postgres);
        await using var appScope = app;
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        Strings((await GetMeAsync(app, guest.Login.AccessToken)).GetProperty("permissions")).Should().HaveCount(5);

        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.PermissionsChange);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        using var put = await app.SendAsync(
            HttpMethod.Put, $"/api/v1/identity/guests/{guest.UserId}/permissions", new { permissions = PermissionLists.Training }, owner.AccessToken);
        put.StatusCode.Should().Be(HttpStatusCode.OK);

        Strings((await GetMeAsync(app, guest.Login.AccessToken)).GetProperty("permissions")).Should().Equal("module:training");
    }

    // ----- PATCH /me -----

    [Fact]
    public async Task Patch_ChangesTheOwnersName_ConfirmsIt_AndAudits_WithoutTheNameInTheTrail()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        app.Time.Advance(TimeSpan.FromMinutes(1));

        using var response = await PatchAsync(app, owner.AccessToken, new { displayName = "  Neemias   Cormino " });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await PasskeyApp.JsonAsync(response);
        body.GetProperty("displayName").GetString().Should().Be("Neemias Cormino", "aparado e com os espaços repetidos colapsados");
        body.GetProperty("displayNameConfirmed").GetBoolean().Should().BeTrue();
        (await GetMeAsync(app, owner.AccessToken)).GetProperty("displayName").GetString().Should().Be("Neemias Cormino");

        await using var db = app.Db();
        var user = await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, Ct);
        user.DisplayName.Should().Be("Neemias Cormino");
        user.DisplayNameConfirmedAt.Should().Be(app.Time.GetUtcNow());
        var audit = await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.ProfileUpdated, Ct);
        audit.UserId.Should().Be(user.Id);
        audit.Detail.Should().Be("display-name", "só diz qual campo mudou");
        var trail = string.Join('\n', (await db.LoginAudit.ToListAsync(Ct)).Select(a => $"{a.Event}|{a.Detail}|{a.Ip}|{a.UserAgent}"));
        trail.Should().NotContain("Neemias").And.NotContain("Cormino");
        app.Logs.Lines.Should().NotContain(l => l.Contains("Cormino", StringComparison.Ordinal), "o nome nunca vai para o log");
    }

    [Fact]
    public async Task Patch_ByAGuest_ChangesOnlyTheGuestsOwnRow()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Convite");

        using var response = await PatchAsync(app, guest.Login.AccessToken, new { displayName = "Alice" });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        var guestRow = await db.Users.SingleAsync(u => u.Id == guest.UserId, Ct);
        guestRow.DisplayName.Should().Be("Alice");
        guestRow.DisplayNameConfirmedAt.Should().NotBeNull();
        var ownerRow = await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, Ct);
        ownerRow.DisplayNameConfirmedAt.Should().BeNull("o dono nem foi tocado");
        ownerRow.DisplayName.Should().NotBe("Alice");
        (await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.ProfileUpdated, Ct)).UserId.Should().Be(guest.UserId);
    }

    [Fact]
    public async Task Patch_AcceptsAComposedEmoji_AndKeepsTheAccentsInNfc()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await PatchAsync(app, owner.AccessToken, new { displayName = "Jose\u0301 \U0001F469\u200D\U0001F4BB" });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await PasskeyApp.JsonAsync(response)).GetProperty("displayName").GetString().Should().Be("José \U0001F469\u200D\U0001F4BB");
    }

    public static TheoryData<string> InvalidNames => new()
    {
        "",
        "   ",
        "Ana\u200BMaria",       // espaço de largura zero
        "\u202EAna",            // sobreposição direita-esquerda
        "Ana\u2066",            // isolamento bidirecional
        "Ana\tMaria",           // tab
        "Ana\nMaria",           // quebra de linha
        "Ana\u0001",            // controle
        new string('a', 61),    // longo demais
        "\u200D\U0001F469",     // junção solta
        "...",                  // sem letra, número ou emoji
    };

    [Theory]
    [MemberData(nameof(InvalidNames))]
    public async Task Patch_WithAnInvalidName_Returns400WithProblemDetails_AndChangesNothing(string name)
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await PatchAsync(app, owner.AccessToken, new { displayName = name });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/problem+json");
        var body = await PasskeyApp.JsonAsync(response);
        body.GetProperty("type").GetString().Should().EndWith("/validation-failed");
        body.GetProperty("errors").GetProperty("displayName").GetArrayLength().Should().Be(1);
        await using var db = app.Db();
        var user = await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, Ct);
        user.DisplayNameConfirmedAt.Should().BeNull();
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.ProfileUpdated, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Patch_WithALoneSurrogateInTheJson_IsRefusedWith400_NeverA500()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        // O JSON cru, com um substituto solto escapado (meio emoji): não passa pelo serializador do teste, que o recusaria.
        using var request = new HttpRequestMessage(HttpMethod.Patch, MeRoute)
        {
            Content = new StringContent("{\"displayName\":\"Ana\\ud83d\"}", System.Text.Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", owner.AccessToken);
        using var response = await app.Client.SendAsync(request, Ct);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, Ct)).DisplayNameConfirmedAt.Should().BeNull();
    }

    [Fact]
    public async Task Patch_WithoutTheField_Returns400()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var missing = await PatchAsync(app, owner.AccessToken, new { });
        using var explicitNull = await PatchAsync(app, owner.AccessToken, new { displayName = (string?)null });

        missing.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        explicitNull.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Patch_Sixty_CodePoints_Pass_AndSixtyOne_DoNot()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var ok = await PatchAsync(app, owner.AccessToken, new { displayName = new string('a', 60) });
        using var tooLong = await PatchAsync(app, owner.AccessToken, new { displayName = new string('a', 61) });

        ok.StatusCode.Should().Be(HttpStatusCode.OK);
        tooLong.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Patch_WithoutAToken_Returns401()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);

        using var response = await PatchAsync(app, null, new { displayName = "Ana" });

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Patch_ByARevokedGuest_Returns403_EvenWithTheJwtStillValid()
    {
        var app = await PasskeyApp.StartAsync(postgres);
        await using var appScope = app;
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke", bearer: owner.AccessToken);
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var response = await PatchAsync(app, guest.Login.AccessToken, new { displayName = "Alice" });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await using var db = app.Db();
        (await db.Users.SingleAsync(u => u.Id == guest.UserId, Ct)).DisplayNameConfirmedAt.Should().BeNull();
    }

    [Fact]
    public async Task Patch_IsRateLimited_PerAccount_WithRetryAfter()
    {
        await using var app = await PasskeyApp.StartAsync(postgres, new PasskeyAppOptions
        {
            Extra = new Dictionary<string, string?> { ["RateLimiting:profile:Permitted"] = "2" },
        });
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        var statuses = new List<HttpStatusCode>();
        HttpResponseMessage? last = null;
        for (var i = 0; i < 3; i++)
        {
            last?.Dispose();
            last = await PatchAsync(app, owner.AccessToken, new { displayName = $"Nome {i}" });
            statuses.Add(last.StatusCode);
        }

        statuses.Should().Equal(HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.TooManyRequests);
        last!.Headers.RetryAfter.Should().NotBeNull();
        last.Dispose();

        // O balde é por conta: a outra pessoa, do mesmo endereço, segue livre.
        using var other = await PatchAsync(app, guest.Login.AccessToken, new { displayName = "Alice" });
        other.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
