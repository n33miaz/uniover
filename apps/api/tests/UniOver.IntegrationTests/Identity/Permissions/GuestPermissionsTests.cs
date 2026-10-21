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

/// <summary>
/// O que cada convidado pode fazer: o convite carrega as permissões, o aceite as copia para a conta na mesma
/// transação e o dono as edita depois (com passkey), com auditoria. As permissões vêm sempre do banco.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class GuestPermissionsTests(PostgresFixture postgres)
{
    private const string InvitesRoute = "/api/v1/identity/guest-invites";
    private const string GuestsRoute = "/api/v1/identity/guests";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly string[] TvControlModel = PermissionLists.TvControlModel;

    private async Task<(PasskeyApp App, LoggedIn Owner, VirtualAuthenticator Authenticator)> StartOwnerAsync(PasskeyAppOptions? options = null)
    {
        var app = await PasskeyApp.StartAsync(postgres, options);
        var owner = await app.LoginAsync();
        var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);
        return (app, owner, authenticator);
    }

    private static async Task<JsonElement> CreateInviteAsync(
        PasskeyApp app, LoggedIn owner, VirtualAuthenticator authenticator, object body, HttpStatusCode expected = HttpStatusCode.OK)
    {
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.GuestInvite);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.SendAsync(HttpMethod.Post, InvitesRoute, body, owner.AccessToken);
        response.StatusCode.Should().Be(expected, await response.Content.ReadAsStringAsync(Ct));
        return await PasskeyApp.JsonAsync(response);
    }

    private static async Task ConfirmPermissionsChangeAsync(PasskeyApp app, LoggedIn owner, VirtualAuthenticator authenticator)
    {
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.PermissionsChange);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private static Task<HttpResponseMessage> PutPermissionsAsync(PasskeyApp app, LoggedIn owner, Guid guestId, object? body) =>
        app.SendAsync(HttpMethod.Put, $"{GuestsRoute}/{guestId}/permissions", body, owner.AccessToken);

    private static string[] Strings(JsonElement array) => [.. array.EnumerateArray().Select(e => e.GetString()!)];

    private static async Task<string[]> StoredGrantsAsync(PasskeyApp app, Guid userId)
    {
        await using var db = app.Db();
        return [.. (await db.UserGrants.Where(g => g.UserId == userId).Select(g => g.Permission).ToListAsync(Ct)).Order(StringComparer.Ordinal)];
    }

    private static string[] Sorted(IEnumerable<string> permissions) => [.. permissions.Order(StringComparer.Ordinal)];

    // ----- Convite -----

    [Fact]
    public async Task CreateInvite_WithoutAList_IsTheTvControlModel_ExactlyWhatTheExistingGuestHas()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        var created = await CreateInviteAsync(app, owner, authenticator, new { displayName = "Alice" });

        Strings(created.GetProperty("permissions")).Should().Equal(TvControlModel);
        await using var db = app.Db();
        (await db.GuestInvites.SingleAsync(Ct)).Permissions.Should().Equal(TvControlModel);
        (await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.GuestInviteCreated, Ct)).Detail
            .Should().Be($"{created.GetProperty("id").GetGuid():N}|{string.Join(',', TvControlModel)}");
    }

    [Fact]
    public async Task CreateInvite_WithAList_StoresItNormalized_InCatalogOrder()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        var created = await CreateInviteAsync(
            app, owner, authenticator, new { displayName = "Raphael", permissions = PermissionLists.OutOfOrderWithARepeat });

        Strings(created.GetProperty("permissions")).Should().Equal("module:tv", "tv:power", "module:training");
        await using var db = app.Db();
        (await db.GuestInvites.SingleAsync(Ct)).Permissions.Should().Equal("module:tv", "tv:power", "module:training");
    }

    [Fact]
    public async Task CreateInvite_OnlyTraining_GrantsNothingOfTheTv()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        var created = await CreateInviteAsync(app, owner, authenticator, new { displayName = "Raphael", permissions = PermissionLists.Training });

        Strings(created.GetProperty("permissions")).Should().Equal("module:training");
    }

    public static TheoryData<string[]> BadLists => new()
    {
        PermissionLists.ActionAlone,
        PermissionLists.ActionWithAnotherModule,
        PermissionLists.UnknownItem,
        PermissionLists.UpperCaseItem,
        PermissionLists.PaddedItem,
        PermissionLists.Empty,
    };

    [Theory]
    [MemberData(nameof(BadLists))]
    public async Task CreateInvite_WithAListOutsideTheRules_Returns400WithProblemDetails_AndStoresNothing(string[] permissions)
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.GuestInvite);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.SendAsync(HttpMethod.Post, InvitesRoute, new { displayName = "Alice", permissions }, owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/problem+json");
        var body = await PasskeyApp.JsonAsync(response);
        body.GetProperty("type").GetString().Should().EndWith("/validation-failed");
        body.GetProperty("errors").GetProperty("permissions").GetArrayLength().Should().BeGreaterThan(0);
        body.GetRawText().Should().NotContain("nao-existe", "o erro não repete o que foi enviado");
        await using var db = app.Db();
        (await db.GuestInvites.CountAsync(Ct)).Should().Be(0);
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.GuestInviteCreated, Ct)).Should().Be(0);
    }

    [Theory]
    [InlineData("Ali\u200Bce")]
    [InlineData("\u202EAlice")]
    [InlineData("Ali\nce")]
    public async Task CreateInvite_WithAnInvisibleOrControlCharacterInTheName_Returns400(string name)
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        var body = await CreateInviteAsync(app, owner, authenticator, new { displayName = name }, HttpStatusCode.BadRequest);

        body.GetProperty("errors").TryGetProperty("displayName", out _).Should().BeTrue();
    }

    [Fact]
    public async Task CreateInvite_WithoutPasskey_StillReturns403_EvenWithAValidList()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        using var response = await app.SendAsync(
            HttpMethod.Post, InvitesRoute, new { displayName = "Alice", permissions = PermissionLists.TvOnly }, owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PasskeyApp.JsonAsync(response)).GetProperty("code").GetString().Should().Be("step_up_required");
    }

    // ----- Aceite -----

    [Fact]
    public async Task Accept_CopiesTheInvitePermissionsToTheAccount_WhoGrantedAndWhen()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var created = await CreateInviteAsync(
            app, owner, authenticator, new { displayName = "Raphael", permissions = PermissionLists.TvControlAndTraining });
        app.Time.Advance(TimeSpan.FromHours(3));

        using var accepted = await GuestSeed.AcceptAsync(app.Client, created.GetProperty("token").GetString(), GuestSeed.NewEmail(), GuestSeed.NewPassword());
        var login = await GuestSeed.ReadLoginAsync(accepted);

        await using var db = app.Db();
        var guest = await db.Users.SingleAsync(u => u.Role == AccountRoles.Guest, Ct);
        var grants = await db.UserGrants.Where(g => g.UserId == guest.Id).ToListAsync(Ct);
        Sorted(grants.Select(g => g.Permission)).Should().Equal("module:training", "module:tv", "tv:control");
        var ownerId = (await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, Ct)).Id;
        grants.Should().OnlyContain(g => g.GrantedBy == ownerId && g.GrantedAt == app.Time.GetUtcNow());

        using var me = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: login.AccessToken);
        var profile = await PasskeyApp.JsonAsync(me);
        Strings(profile.GetProperty("permissions")).Should().Equal("module:tv", "tv:control", "module:training");
        profile.GetProperty("displayNameConfirmed").GetBoolean().Should().BeFalse("o nome veio do convite: a pessoa ainda vai escolher");
    }

    [Fact]
    public async Task Accept_OfAnInviteWithoutAList_GivesTheTvControlModel()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);

        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        (await StoredGrantsAsync(app, guest.UserId)).Should().Equal(Sorted(TvControlModel));
    }

    [Fact]
    public async Task Accept_WithAnEmailInUse_CreatesNoGrants_AndTheInviteKeepsItsList()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (inviteId, token) = await GuestSeed.InsertInviteAsync(
            app.Database, app.Time.GetUtcNow(), permissions: ["module:tv", "tv:history"]);

        using var taken = await GuestSeed.AcceptAsync(app.Client, token, app.OwnerEmail, GuestSeed.NewPassword());

        taken.StatusCode.Should().Be(HttpStatusCode.Conflict);
        await using (var db = app.Db())
        {
            (await db.UserGrants.CountAsync(Ct)).Should().Be(0, "a transação desfez tudo");
            (await db.GuestInvites.SingleAsync(i => i.Id == inviteId, Ct)).UsedAt.Should().BeNull();
        }

        using var good = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword());
        good.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var check = app.Db();
        Sorted((await check.UserGrants.Select(g => g.Permission).ToListAsync(Ct))).Should().Equal("module:tv", "tv:history");
    }

    [Fact]
    public async Task Accept_Simultaneously_CreatesOneAccountWithOneSetOfGrants()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (_, token) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow());

        var statuses = await Task.WhenAll(Enumerable.Range(0, 6).Select(async _ =>
        {
            using var response = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword());
            return response.StatusCode;
        }));

        statuses.Count(s => s == HttpStatusCode.OK).Should().Be(1);
        await using var db = app.Db();
        (await db.UserGrants.CountAsync(Ct)).Should().Be(TvControlModel.Length, "só a conta que nasceu ganhou as permissões");
    }

    [Fact]
    public async Task Accept_OfAnInviteWhoseListBrokeTheRules_IsRefusedLikeAnyInvalidInvite()
    {
        // O banco aceita {tv:control} sozinho (é subconjunto do catálogo), mas a regra de dependência não: falha fechada.
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (inviteId, token) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow());
        await using (var db = app.Db())
        {
            await db.Database.ExecuteSqlRawAsync("UPDATE identity.guest_invites SET permissions = ARRAY['tv:control']::text[]", Ct);
        }

        using var response = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword());

        response.StatusCode.Should().Be(HttpStatusCode.Gone);
        await using var check = app.Db();
        (await check.Users.CountAsync(u => u.Role == AccountRoles.Guest, Ct)).Should().Be(0);
        (await check.UserGrants.CountAsync(Ct)).Should().Be(0);
        (await check.GuestInvites.SingleAsync(i => i.Id == inviteId, Ct)).UsedAt.Should().BeNull();
    }

    // ----- Edição depois -----

    [Fact]
    public async Task SetPermissions_WithoutPasskeyConfirmation_Returns403StepUpRequired_AndChangesNothing()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var response = await PutPermissionsAsync(app, owner, guest.UserId, new { permissions = PermissionLists.TvAndTraining });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var body = await PasskeyApp.JsonAsync(response);
        body.GetProperty("code").GetString().Should().Be("step_up_required");
        body.GetProperty("action").GetString().Should().Be("identity.permissions-change");
        (await StoredGrantsAsync(app, guest.UserId)).Should().Equal(Sorted(TvControlModel));
    }

    [Fact]
    public async Task SetPermissions_ConfirmedForAnotherAction_IsNotEnough()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.GuestInvite);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await PutPermissionsAsync(app, owner, guest.UserId, new { permissions = PermissionLists.Training });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await StoredGrantsAsync(app, guest.UserId)).Should().Equal(Sorted(TvControlModel));
    }

    [Fact]
    public async Task SetPermissions_WithPasskey_ReplacesTheWholeSet_KeepsWhoGrantedTheRest_AndAudits()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Alice Souza");
        var createdAt = app.Time.GetUtcNow();
        app.Time.Advance(TimeSpan.FromMinutes(2));
        await ConfirmPermissionsChangeAsync(app, owner, authenticator);

        using var response = await PutPermissionsAsync(
            app, owner, guest.UserId, new { permissions = PermissionLists.SwapEverything });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await PasskeyApp.JsonAsync(response);
        Strings(body.GetProperty("permissions")).Should().Equal("module:tv", "tv:control", "tv:edit-shortcuts", "module:training");
        body.GetProperty("id").GetGuid().Should().Be(guest.UserId);

        await using var db = app.Db();
        var rows = await db.UserGrants.Where(g => g.UserId == guest.UserId).ToListAsync(Ct);
        Sorted(rows.Select(r => r.Permission)).Should().Equal("module:training", "module:tv", "tv:control", "tv:edit-shortcuts");
        var ownerId = (await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, Ct)).Id;
        rows.Single(r => r.Permission == "tv:control").GrantedAt.Should().Be(createdAt, "o que já valia mantém quando e quem");
        rows.Where(r => r.Permission is "module:training" or "tv:edit-shortcuts")
            .Should().OnlyContain(r => r.GrantedBy == ownerId && r.GrantedAt == app.Time.GetUtcNow());

        var audit = await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.PermissionsChanged, Ct);
        audit.UserId.Should().Be(ownerId);
        audit.Detail.Should().Be($"{guest.UserId:N}|+module:training,tv:edit-shortcuts|-tv:history,tv:launch,tv:power");
        audit.Detail.Should().NotContain("Alice").And.NotContain(guest.Email);
    }

    [Fact]
    public async Task SetPermissions_WithTheSameSet_ChangesNothing_AndWritesNoAudit()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        await ConfirmPermissionsChangeAsync(app, owner, authenticator);

        using var response = await PutPermissionsAsync(app, owner, guest.UserId, new { permissions = TvControlModel });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var db = app.Db();
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.PermissionsChanged, Ct)).Should().Be(0);
        (await StoredGrantsAsync(app, guest.UserId)).Should().Equal(Sorted(TvControlModel));
    }

    [Theory]
    [MemberData(nameof(BadLists))]
    public async Task SetPermissions_WithAListOutsideTheRules_Returns400_AndChangesNothing(string[] permissions)
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        await ConfirmPermissionsChangeAsync(app, owner, authenticator);

        using var response = await PutPermissionsAsync(app, owner, guest.UserId, new { permissions });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await PasskeyApp.JsonAsync(response)).GetProperty("errors").GetProperty("permissions").GetArrayLength().Should().BeGreaterThan(0);
        (await StoredGrantsAsync(app, guest.UserId)).Should().Equal(Sorted(TvControlModel));
    }

    [Fact]
    public async Task SetPermissions_WithoutTheListOrWithNullItems_Returns400()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        await ConfirmPermissionsChangeAsync(app, owner, authenticator);

        using var missing = await PutPermissionsAsync(app, owner, guest.UserId, new { });
        using var nullItem = await PutPermissionsAsync(app, owner, guest.UserId, new { permissions = PermissionLists.WithANullItem });

        missing.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        nullItem.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await StoredGrantsAsync(app, guest.UserId)).Should().Equal(Sorted(TvControlModel));
    }

    [Fact]
    public async Task SetPermissions_ForAnUnknownIdOrTheOwner_Returns404()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        Guid ownerId;
        await using (var db = app.Db())
        {
            ownerId = (await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, Ct)).Id;
        }

        await ConfirmPermissionsChangeAsync(app, owner, authenticator);
        using var unknown = await PutPermissionsAsync(app, owner, Guid.NewGuid(), new { permissions = PermissionLists.TvOnly });
        using var self = await PutPermissionsAsync(app, owner, ownerId, new { permissions = PermissionLists.TvOnly });

        unknown.StatusCode.Should().Be(HttpStatusCode.NotFound);
        self.StatusCode.Should().Be(HttpStatusCode.NotFound, "o dono tem tudo de forma implícita: não há o que editar");
        await using var check = app.Db();
        (await check.UserGrants.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task SetPermissions_ForARevokedGuest_Returns409_AndChangesNothing()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var revoke = await app.SendAsync(HttpMethod.Post, $"{GuestsRoute}/{guest.UserId}/revoke", bearer: owner.AccessToken);
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await ConfirmPermissionsChangeAsync(app, owner, authenticator);

        using var response = await PutPermissionsAsync(app, owner, guest.UserId, new { permissions = PermissionLists.Training });

        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await PasskeyApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/guest-revoked");
        (await StoredGrantsAsync(app, guest.UserId)).Should().Equal(Sorted(TvControlModel));
    }

    [Fact]
    public async Task SetPermissions_ByAGuest_Returns403_AndTheGuestKeepsItsOwnSet()
    {
        var (app, _, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var response = await app.SendAsync(
            HttpMethod.Put, $"{GuestsRoute}/{guest.UserId}/permissions", new { permissions = AccessPermissions.All }, guest.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await StoredGrantsAsync(app, guest.UserId)).Should().Equal(Sorted(TvControlModel));
    }

    [Fact]
    public async Task ListGuests_ReturnsEachGuestsPermissions_AndTheInvitesListWhatTheyWillGrant()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var alice = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Alice");
        var raphael = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Raphael", ["module:training"]);
        await CreateInviteAsync(app, owner, authenticator, new { displayName = "Pendente", permissions = PermissionLists.TvAndHistory });

        using var guests = await app.SendAsync(HttpMethod.Get, GuestsRoute, bearer: owner.AccessToken);
        using var invites = await app.SendAsync(HttpMethod.Get, InvitesRoute, bearer: owner.AccessToken);

        var rows = (await PasskeyApp.JsonAsync(guests)).EnumerateArray().ToDictionary(e => e.GetProperty("id").GetGuid());
        Strings(rows[alice.UserId].GetProperty("permissions")).Should().Equal(TvControlModel);
        Strings(rows[raphael.UserId].GetProperty("permissions")).Should().Equal("module:training");
        var pending = (await PasskeyApp.JsonAsync(invites)).EnumerateArray().Single(e => e.GetProperty("status").GetString() == "pending");
        Strings(pending.GetProperty("permissions")).Should().Equal("module:tv", "tv:history");
    }
}
