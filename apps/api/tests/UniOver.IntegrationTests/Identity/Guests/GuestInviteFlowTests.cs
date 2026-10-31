using System.Net;
using System.Security.Cryptography;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.IntegrationTests.Identity.Guests;

/// <summary>O convite do dono de ponta a ponta: criar com a passkey, aceitar, listar, revogar.</summary>
[Collection(PostgresGroup.Name)]
public sealed class GuestInviteFlowTests(PostgresFixture postgres)
{
    private const string InvitesRoute = "/api/v1/identity/guest-invites";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(PasskeyApp App, LoggedIn Owner, VirtualAuthenticator Authenticator)> StartOwnerAsync(
        PasskeyAppOptions? options = null)
    {
        var app = await PasskeyApp.StartAsync(postgres, options);
        var owner = await app.LoginAsync();
        var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);
        return (app, owner, authenticator);
    }

    private static async Task<JsonElementResult> CreateInviteAsync(
        PasskeyApp app, LoggedIn owner, VirtualAuthenticator authenticator, string name = "Alice")
    {
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.GuestInvite);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.SendAsync(HttpMethod.Post, InvitesRoute, new { displayName = name }, owner.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await PasskeyApp.JsonAsync(response);
        return new JsonElementResult(
            body.GetProperty("id").GetGuid(),
            body.GetProperty("token").GetString()!,
            body.GetProperty("expiresAt").GetDateTimeOffset(),
            response.Headers.CacheControl?.NoStore == true);
    }

    private sealed record JsonElementResult(Guid Id, string Token, DateTimeOffset ExpiresAt, bool NoStore);

    [Fact]
    public async Task CreateInvite_WithoutPasskeyConfirmation_Returns403StepUpRequired_AndStoresNothing()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        using var response = await app.SendAsync(HttpMethod.Post, InvitesRoute, new { displayName = "Alice" }, owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var body = await PasskeyApp.JsonAsync(response);
        body.GetProperty("code").GetString().Should().Be("step_up_required");
        body.GetProperty("action").GetString().Should().Be("identity.guest-invite");
        await using var db = app.Db();
        (await db.GuestInvites.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task CreateInvite_ConfirmedForAnotherAction_IsNotEnough()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        using var confirm = await app.ConfirmAsync(owner, authenticator, PasskeyApp.DangerousAction);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.SendAsync(HttpMethod.Post, InvitesRoute, new { displayName = "Alice" }, owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task CreateInvite_WithPasskey_ReturnsTheLinkSecretOnce_AndStoresOnlyItsHash()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;

        var created = await CreateInviteAsync(app, owner, authenticator);

        created.NoStore.Should().BeTrue("a resposta traz o segredo");
        created.ExpiresAt.Should().Be(app.Time.GetUtcNow().AddDays(7), "validade padrão de 7 dias");
        await using var db = app.Db();
        var stored = await db.GuestInvites.SingleAsync(Ct);
        stored.Id.Should().Be(created.Id);
        stored.TokenHash.Should().Equal(SecretTokens.Hash(created.Token));
        stored.Label.Should().Be("Alice");
        stored.Role.Should().Be(AccountRoles.Guest);
        var audit = await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.GuestInviteCreated, Ct);

        // O detalhe leva o id do convite e a lista de permissões (não é dado sensível), nunca o segredo nem o nome.
        audit.Detail.Should().Be($"{created.Id:N}|module:tv,tv:control,tv:power,tv:launch,tv:history");
        audit.Detail.Should().NotContain(created.Token).And.NotContain("Alice");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task CreateInvite_WithoutAName_Returns400(string name)
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.GuestInvite);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.SendAsync(HttpMethod.Post, InvitesRoute, new { displayName = name }, owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task CreateInvite_BeyondThePendingLimit_Returns409_UntilOneIsRevoked()
    {
        var (app, owner, authenticator) = await StartOwnerAsync(new PasskeyAppOptions
        {
            Extra = new Dictionary<string, string?> { ["Modules:Identity:MaxPendingGuestInvites"] = "1" },
        });
        await using var appScope = app;
        using var authScope = authenticator;

        var first = await CreateInviteAsync(app, owner, authenticator);
        using var refused = await app.SendAsync(HttpMethod.Post, InvitesRoute, new { displayName = "Outra" }, owner.AccessToken);
        using var revoke = await app.SendAsync(HttpMethod.Post, $"{InvitesRoute}/{first.Id}/revoke", bearer: owner.AccessToken);
        using var again = await app.SendAsync(HttpMethod.Post, InvitesRoute, new { displayName = "Outra" }, owner.AccessToken);

        refused.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await PasskeyApp.JsonAsync(refused)).GetProperty("type").GetString().Should().EndWith("/too-many-invites");
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        again.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Accept_CreatesTheGuestWithTheirOwnPassword_AndOpensASession()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var created = await CreateInviteAsync(app, owner, authenticator, "Alice");
        var email = GuestSeed.NewEmail();
        var password = GuestSeed.NewPassword();

        using var response = await GuestSeed.AcceptAsync(app.Client, created.Token, email, password);
        var login = await GuestSeed.ReadLoginAsync(response);

        login.RefreshCookie.Has("httponly").Should().BeTrue();
        login.RefreshCookie.Get("samesite").Should().Be("strict");
        using var me = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: login.AccessToken);
        var profile = await PasskeyApp.JsonAsync(me);
        profile.GetProperty("role").GetString().Should().Be("guest");
        profile.GetProperty("displayName").GetString().Should().Be("Alice");
        profile.GetProperty("email").GetString().Should().Be(email);

        await using var db = app.Db();
        var guest = await db.Users.SingleAsync(u => u.Email == email, Ct);
        guest.Role.Should().Be(AccountRoles.Guest);
        guest.PasswordHash.Should().NotContain(password, "só o hash vai ao banco");
        var invite = await db.GuestInvites.SingleAsync(Ct);
        invite.UsedAt.Should().Be(app.Time.GetUtcNow());
        invite.UsedBy.Should().Be(guest.Id);
        (await db.LoginAudit.Where(a => a.Event == AuditEvents.GuestInviteAccepted).SingleAsync(Ct)).UserId.Should().Be(guest.Id);

        // O convidado entra depois com o e-mail e a senha que escolheu, e o dono nunca teve a senha.
        using var secondLogin = await GuestLoginAsync(app, email, password);
        secondLogin.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private static async Task<HttpResponseMessage> GuestLoginAsync(PasskeyApp app, string email, string password)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/login")
        {
            Content = System.Net.Http.Json.JsonContent.Create(new { email, password }),
        };
        request.Headers.Add(IdentityApp.ClientHeader, "web");
        return await app.Client.SendAsync(request, Ct);
    }

    [Fact]
    public async Task Accept_TheSameInviteTwice_IsRefused()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (_, token) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow());

        using var first = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword());
        using var second = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword());

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.Gone);
        (await PasskeyApp.JsonAsync(second)).GetProperty("type").GetString().Should().EndWith("/invite-invalid");
        await using var db = app.Db();
        (await db.Users.CountAsync(u => u.Role == AccountRoles.Guest, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Accept_AfterTheExpiry_IsRefused_AndOneSecondBeforeStillWorks()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (_, early) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow(), "Cedo");
        var (_, late) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow(), "Tarde");

        app.Time.Advance(TimeSpan.FromHours(48) - TimeSpan.FromSeconds(1));
        using var stillValid = await GuestSeed.AcceptAsync(app.Client, early, GuestSeed.NewEmail(), GuestSeed.NewPassword());
        app.Time.Advance(TimeSpan.FromSeconds(1));
        using var expired = await GuestSeed.AcceptAsync(app.Client, late, GuestSeed.NewEmail(), GuestSeed.NewPassword());

        stillValid.StatusCode.Should().Be(HttpStatusCode.OK);
        expired.StatusCode.Should().Be(HttpStatusCode.Gone);
    }

    [Fact]
    public async Task Accept_AfterTheOwnerRevokedTheInvite_IsRefused()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var created = await CreateInviteAsync(app, owner, authenticator);
        using var revoke = await app.SendAsync(HttpMethod.Post, $"{InvitesRoute}/{created.Id}/revoke", bearer: owner.AccessToken);

        using var response = await GuestSeed.AcceptAsync(app.Client, created.Token, GuestSeed.NewEmail(), GuestSeed.NewPassword());

        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        response.StatusCode.Should().Be(HttpStatusCode.Gone);
        await using var db = app.Db();
        (await db.Users.CountAsync(u => u.Role == AccountRoles.Guest, Ct)).Should().Be(0);
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.GuestInviteRevoked, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Accept_WithATamperedOrInventedSecret_IsRefusedTheSameWay()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (_, token) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow());
        var tampered = (token[0] == 'A' ? 'B' : 'A') + token[1..];
        var invented = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).Replace('+', '-').Replace('/', '_').TrimEnd('=');

        foreach (var candidate in new[] { tampered, invented, "curto", token + "AA", "!!!" })
        {
            using var response = await GuestSeed.AcceptAsync(app.Client, candidate, GuestSeed.NewEmail(), GuestSeed.NewPassword());
            response.StatusCode.Should().Be(HttpStatusCode.Gone, $"segredo adulterado ({candidate.Length} caracteres) não distingue nada");
            (await PasskeyApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/invite-invalid");
        }

        // O convite verdadeiro continua intacto.
        using var good = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword());
        good.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Accept_WithABadPasswordOrEmail_Returns400_AndKeepsTheInviteUsable()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (_, token) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow());
        const string shortPassword = "curta-1";

        using var tooShort = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), shortPassword);
        using var noEmail = await GuestSeed.AcceptAsync(app.Client, token, "sem-arroba", GuestSeed.NewPassword());
        using var noToken = await GuestSeed.AcceptAsync(app.Client, null, GuestSeed.NewEmail(), GuestSeed.NewPassword());
        using var noHeader = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword(), clientHeader: false);

        tooShort.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await tooShort.Content.ReadAsStringAsync(Ct)).Should().NotContain(shortPassword);
        noEmail.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        noToken.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        noHeader.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var good = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword());
        good.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Accept_WithAnEmailAlreadyInUse_Returns409_AndDoesNotBurnTheInvite()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (inviteId, token) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow());

        using var taken = await GuestSeed.AcceptAsync(app.Client, token, app.OwnerEmail.ToUpperInvariant(), GuestSeed.NewPassword());

        taken.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await PasskeyApp.JsonAsync(taken)).GetProperty("type").GetString().Should().EndWith("/email-unavailable");
        await using (var db = app.Db())
        {
            (await db.GuestInvites.SingleAsync(i => i.Id == inviteId, Ct)).UsedAt.Should().BeNull("a transação desfez a reivindicação");
        }

        using var good = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword());
        good.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Accept_Simultaneously_CreatesExactlyOneAccount()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (_, token) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow());

        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            using var response = await GuestSeed.AcceptAsync(app.Client, token, GuestSeed.NewEmail(), GuestSeed.NewPassword());
            return response.StatusCode;
        }));

        responses.Count(s => s == HttpStatusCode.OK).Should().Be(1);
        responses.Count(s => s == HttpStatusCode.Gone).Should().Be(7);
        await using var db = app.Db();
        (await db.Users.CountAsync(u => u.Role == AccountRoles.Guest, Ct)).Should().Be(1);
        (await db.RefreshTokens.CountAsync(Ct)).Should().Be(1, "só a conta que nasceu abriu sessão");
    }

    [Fact]
    public async Task Accept_TwoInvitesWithTheSameEmailAtOnce_CreatesOneAccount_AndTheOtherInviteSurvives()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var (_, tokenA) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow(), "A");
        var (_, tokenB) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow(), "B");
        var email = GuestSeed.NewEmail();

        var statuses = await Task.WhenAll(new[] { tokenA, tokenB }.Select(async token =>
        {
            using var response = await GuestSeed.AcceptAsync(app.Client, token, email, GuestSeed.NewPassword());
            return response.StatusCode;
        }));

        statuses.Should().BeEquivalentTo([HttpStatusCode.OK, HttpStatusCode.Conflict]);
        await using var db = app.Db();
        (await db.Users.CountAsync(u => u.Email == email, Ct)).Should().Be(1);
        (await db.GuestInvites.CountAsync(i => i.UsedAt == null, Ct)).Should().Be(1, "o convite que perdeu a corrida não foi gasto");
    }

    [Fact]
    public async Task Accept_IsRateLimitedPerIp_WithRetryAfter()
    {
        await using var app = await PasskeyApp.StartAsync(postgres, new PasskeyAppOptions
        {
            Extra = new Dictionary<string, string?> { ["RateLimiting:guest-invite:Permitted"] = "3" },
        });

        var statuses = new List<HttpStatusCode>();
        HttpResponseMessage? last = null;
        for (var i = 0; i < 4; i++)
        {
            last?.Dispose();
            last = await GuestSeed.AcceptAsync(app.Client, "curto", GuestSeed.NewEmail(), GuestSeed.NewPassword());
            statuses.Add(last.StatusCode);
        }

        statuses.Should().Equal(HttpStatusCode.Gone, HttpStatusCode.Gone, HttpStatusCode.Gone, HttpStatusCode.TooManyRequests);
        last!.Headers.RetryAfter.Should().NotBeNull();
        last.Dispose();
    }

    [Fact]
    public async Task ListInvites_ShowsEachStatus_AndNeverTheSecret()
    {
        var (app, _, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var now = app.Time.GetUtcNow();
        var (pendingId, pendingToken) = await GuestSeed.InsertInviteAsync(app.Database, now, "Pendente");
        var (usedId, usedToken) = await GuestSeed.InsertInviteAsync(app.Database, now, "Usada");
        var (revokedId, revokedToken) = await GuestSeed.InsertInviteAsync(app.Database, now, "Revogada");
        var (expiredId, expiredToken) = await GuestSeed.InsertInviteAsync(app.Database, now, "Vencida", TimeSpan.FromHours(1));
        using (await GuestSeed.AcceptAsync(app.Client, usedToken, GuestSeed.NewEmail(), GuestSeed.NewPassword()))
        {
        }

        app.Time.Advance(TimeSpan.FromHours(2));
        var owner = await app.LoginAsync();
        using var revoke = await app.SendAsync(HttpMethod.Post, $"{InvitesRoute}/{revokedId}/revoke", bearer: owner.AccessToken);
        using var list = await app.SendAsync(HttpMethod.Get, InvitesRoute, bearer: owner.AccessToken);

        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        list.StatusCode.Should().Be(HttpStatusCode.OK);
        var raw = await list.Content.ReadAsStringAsync(Ct);
        foreach (var secret in new[] { pendingToken, usedToken, revokedToken, expiredToken })
        {
            raw.Should().NotContain(secret);
        }

        var items = System.Text.Json.JsonDocument.Parse(raw).RootElement.EnumerateArray()
            .ToDictionary(e => e.GetProperty("id").GetGuid(), e => e.GetProperty("status").GetString());
        items[pendingId].Should().Be("pending");
        items[usedId].Should().Be("used");
        items[revokedId].Should().Be("revoked");
        items[expiredId].Should().Be("expired");
        System.Text.Json.JsonDocument.Parse(raw).RootElement.EnumerateArray().First()
            .EnumerateObject().Select(p => p.Name).Should().NotContain(["token", "tokenHash"]);
    }

    [Fact]
    public async Task RevokeInvite_AlreadyAccepted_Returns409_AndAnUnknownIdReturns404()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var (usedId, usedToken) = await GuestSeed.InsertInviteAsync(app.Database, app.Time.GetUtcNow());
        using (await GuestSeed.AcceptAsync(app.Client, usedToken, GuestSeed.NewEmail(), GuestSeed.NewPassword()))
        {
        }

        using var used = await app.SendAsync(HttpMethod.Post, $"{InvitesRoute}/{usedId}/revoke", bearer: owner.AccessToken);
        using var unknown = await app.SendAsync(HttpMethod.Post, $"{InvitesRoute}/{Guid.NewGuid()}/revoke", bearer: owner.AccessToken);

        used.StatusCode.Should().Be(HttpStatusCode.Conflict);
        unknown.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task RevokeGuest_EndsTheSessions_BlocksNewLogins_AndTheShortJwtDiesOnItsOwn()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var before = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: guest.Login.AccessToken);
        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke", bearer: owner.AccessToken);
        using var refresh = await SendRefreshAsync(app, guest.Login.RefreshSecret);
        using var login = await GuestLoginAsync(app, guest.Email, guest.Password);
        using var ticket = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: guest.Login.AccessToken);
        using var stillShort = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: guest.Login.AccessToken);
        app.Time.Advance(TimeSpan.FromMinutes(11));
        using var after = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: guest.Login.AccessToken);

        before.StatusCode.Should().Be(HttpStatusCode.OK);
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        refresh.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        login.StatusCode.Should().Be(HttpStatusCode.Unauthorized, "igual a uma senha errada");
        ticket.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        stillShort.StatusCode.Should().Be(HttpStatusCode.OK, "o JWT já emitido vale até o prazo curto dele");
        after.StatusCode.Should().Be(HttpStatusCode.Unauthorized, "passado o prazo curto não há mais acesso");

        await using var db = app.Db();
        (await db.Users.SingleAsync(u => u.Id == guest.UserId, Ct)).DisabledAt.Should().NotBeNull();
        (await db.RefreshTokens.Where(t => t.UserId == guest.UserId).ToListAsync(Ct))
            .Should().OnlyContain(t => t.RevokedAt != null && t.RevokedReason == RevokeReasons.GuestRevoked);
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.GuestRevoked, Ct)).Should().Be(1);
    }

    private static async Task<HttpResponseMessage> SendRefreshAsync(PasskeyApp app, string secret)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/refresh");
        request.Headers.Add(IdentityApp.ClientHeader, "web");
        request.Headers.Add("Cookie", "uo_rt=" + secret);
        return await app.Client.SendAsync(request, Ct);
    }

    [Fact]
    public async Task RefreshOfAGuest_KeepsTheGuestRoleInTheNewJwt()
    {
        await using var app = await PasskeyApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var refresh = await SendRefreshAsync(app, guest.Login.RefreshSecret);

        refresh.StatusCode.Should().Be(HttpStatusCode.OK);
        var token = (await PasskeyApp.JsonAsync(refresh)).GetProperty("accessToken").GetString()!;
        new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().ReadJsonWebToken(token)
            .GetClaim("role").Value.Should().Be("guest");
    }

    [Fact]
    public async Task RevokeGuest_CannotTouchTheOwner_AndOnlyListsGuests()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Alice");
        Guid ownerId;
        await using (var db = app.Db())
        {
            ownerId = (await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, Ct)).Id;
        }

        using var revokeOwner = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{ownerId}/revoke", bearer: owner.AccessToken);
        using var list = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/guests", bearer: owner.AccessToken);

        revokeOwner.StatusCode.Should().Be(HttpStatusCode.NotFound);
        using var ownerStillWorks = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: owner.AccessToken);
        ownerStillWorks.StatusCode.Should().Be(HttpStatusCode.OK);
        var rows = (await PasskeyApp.JsonAsync(list)).EnumerateArray().ToList();
        rows.Should().ContainSingle();
        rows[0].GetProperty("id").GetGuid().Should().Be(guest.UserId);
        rows[0].GetProperty("displayName").GetString().Should().Be("Alice");
        rows[0].EnumerateObject().Select(p => p.Name).Should().NotContain(["passwordHash", "password"]);
    }

    [Fact]
    public async Task NoLogLine_NorAuditRow_CarriesTheInviteSecretOrTheGuestPassword()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var created = await CreateInviteAsync(app, owner, authenticator);
        var email = GuestSeed.NewEmail();
        var password = GuestSeed.NewPassword();
        using var accepted = await GuestSeed.AcceptAsync(app.Client, created.Token, email, password);
        var login = await GuestSeed.ReadLoginAsync(accepted);
        (await GuestSeed.AcceptAsync(app.Client, created.Token, GuestSeed.NewEmail(), password)).Dispose();
        (await GuestLoginAsync(app, email, "errada-" + password)).Dispose();

        string hash;
        string auditText;
        await using (var db = app.Db())
        {
            hash = (await db.Users.SingleAsync(u => u.Email == email, Ct)).PasswordHash;
            auditText = string.Join('\n', (await db.LoginAudit.ToListAsync(Ct)).Select(a => $"{a.Event}|{a.Detail}|{a.Ip}|{a.UserAgent}"));
        }

        var lines = app.Logs.Lines;
        lines.Should().NotBeEmpty();
        foreach (var secret in new[] { created.Token, password, hash, login.AccessToken, login.RefreshSecret })
        {
            lines.Should().NotContain(l => l.Contains(secret, StringComparison.Ordinal), "segredo nenhum pode ir para o log");
            auditText.Should().NotContain(secret);
        }
    }
}
