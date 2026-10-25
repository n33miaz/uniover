using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity.QrLogin;

/// <summary>
/// A entrada pelo QR de ponta a ponta contra o Host e o Postgres reais: o computador abre o pedido, o celular logado vê e
/// confirma, o computador recebe a sessão UMA vez. Sem passkey aqui (a conta do convidado), então a prova é a sessão recente
/// ou a senha; o caminho com passkey está em <see cref="QrLoginPasskeyTests"/>.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class QrLoginTests(PostgresFixture postgres)
{
    private const string Pc = "203.0.113.50";
    private const string Phone = "203.0.113.60";
    private const string PcAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36";
    private const string PhoneAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static IdentityAppOptions Options(IReadOnlyDictionary<string, string?>? extra = null) =>
        new() { ForwardedHeaders = true, Extra = extra };

    private static async Task<(string Code, string Secret, JsonElement Body)> StartAsync(IdentityApp app, string ip = Pc, string agent = PcAgent)
    {
        using var response = await app.SendAsync(HttpMethod.Post, QrRoutes.Start, forwardedFor: ip, userAgent: agent);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl?.NoStore.Should().BeTrue("a resposta leva o segredo de consulta");
        var body = await IdentityApp.JsonAsync(response);
        return (body.GetProperty("code").GetString()!, body.GetProperty("pollSecret").GetString()!, body);
    }

    private static async Task<JsonElement> PollAsync(IdentityApp app, string secret, string ip = Pc, string agent = PcAgent)
    {
        using var response = await app.SendAsync(
            HttpMethod.Post, QrRoutes.Poll, new { secret }, forwardedFor: ip, userAgent: agent);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl?.NoStore.Should().BeTrue();
        return await IdentityApp.JsonAsync(response);
    }

    private static Task<HttpResponseMessage> PollRawAsync(IdentityApp app, string secret, string ip = Pc, string agent = PcAgent) =>
        app.SendAsync(HttpMethod.Post, QrRoutes.Poll, new { secret }, forwardedFor: ip, userAgent: agent);

    private static Task<HttpResponseMessage> InfoAsync(IdentityApp app, string? bearer, string code, string ip = Phone) =>
        app.SendAsync(HttpMethod.Post, QrRoutes.Info, new { code }, bearer, forwardedFor: ip, userAgent: PhoneAgent);

    private static Task<HttpResponseMessage> ApproveAsync(
        IdentityApp app, string? bearer, string code, string? password = null, string ip = Phone) =>
        app.SendAsync(HttpMethod.Post, QrRoutes.Approve, new { code, password }, bearer, forwardedFor: ip, userAgent: PhoneAgent);

    private static Task<HttpResponseMessage> DenyAsync(IdentityApp app, string? bearer, string code) =>
        app.SendAsync(HttpMethod.Post, QrRoutes.Deny, new { code }, bearer, forwardedFor: Phone, userAgent: PhoneAgent);

    private static async Task<GuestSession> NewGuestAsync(IdentityApp app) =>
        await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

    [Fact]
    public async Task FullFlow_GuestScansWithAFreshSession_ThePcGetsItsOwnSessionOnce()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);

        var (code, secret, started) = await StartAsync(app);
        started.GetProperty("expiresIn").GetInt32().Should().Be(120);
        code.Should().HaveLength(16);

        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("pending");

        // O celular vê o aparelho do computador e que a sessão é recente (nenhuma prova extra).
        using var info = await InfoAsync(app, guest.Login.AccessToken, code);
        info.StatusCode.Should().Be(HttpStatusCode.OK);
        var shown = await IdentityApp.JsonAsync(info);
        shown.GetProperty("userAgent").GetString().Should().Be(PcAgent);
        shown.GetProperty("verification").GetString().Should().Be("none");
        shown.GetProperty("sameNetwork").GetBoolean().Should().BeFalse("o celular está em outro IP");

        using var approve = await ApproveAsync(app, guest.Login.AccessToken, code);
        approve.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var poll = await PollRawAsync(app, secret);
        poll.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(poll);
        body.GetProperty("status").GetString().Should().Be("approved");
        var access = body.GetProperty("accessToken").GetString()!;
        body.GetProperty("expiresIn").GetInt32().Should().Be(600);
        var cookie = IdentityApp.Cookies(poll).Should().ContainSingle().Which;
        cookie.Name.Should().Be("uo_rt");
        cookie.Has("httponly").Should().BeTrue();
        cookie.Has("secure").Should().BeTrue();
        cookie.Get("samesite").Should().Be("strict");
        cookie.Get("path").Should().Be("/api/v1/identity/auth");

        // A sessão do PC é uma sessão normal da MESMA conta (papel de convidado, nada além disso), e renova como as outras.
        using var me = await app.GetAsync("/api/v1/identity/me", bearer: access);
        me.StatusCode.Should().Be(HttpStatusCode.OK);
        (await IdentityApp.JsonAsync(me)).GetProperty("role").GetString().Should().Be("guest");
        using var refreshed = await app.RefreshRawAsync(cookie.Value);
        refreshed.StatusCode.Should().Be(HttpStatusCode.OK);

        // Consumo único: o mesmo segredo não rende outra sessão, e o motivo não aparece (igual a um segredo que nunca existiu).
        var again = await PollAsync(app, secret);
        again.GetProperty("status").GetString().Should().Be("expired");
        (again.TryGetProperty("accessToken", out var token) ? token.ValueKind : JsonValueKind.Null).Should().Be(JsonValueKind.Null);

        await using var db = app.Db();
        var request = await db.QrLoginRequests.SingleAsync(Ct);
        request.ConsumedAt.Should().NotBeNull();
        request.ApprovedBy.Should().Be(guest.UserId);

        // Duas famílias de sessão da conta: a do celular e a do PC (a do PC com o IP e o aparelho do COMPUTADOR).
        var sessions = await db.RefreshTokens.Where(t => t.UserId == guest.UserId).ToListAsync(Ct);
        sessions.Select(t => t.FamilyId).Distinct().Should().HaveCount(2);
        sessions.Should().Contain(t => t.Ip == Pc && t.UserAgent == PcAgent);
    }

    [Fact]
    public async Task Audit_RecordsBothSides_CorrelatedByTheRequestId_WithoutSecrets()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);
        (await ApproveAsync(app, guest.Login.AccessToken, code)).Dispose();
        var polled = await PollAsync(app, secret);
        var access = polled.GetProperty("accessToken").GetString()!;

        await using var db = app.Db();
        var request = await db.QrLoginRequests.SingleAsync(Ct);
        var rows = await db.LoginAudit
            .Where(a => a.Event == AuditEvents.QrLoginApproved || a.Event == AuditEvents.QrLoginSucceeded)
            .ToListAsync(Ct);

        var approved = rows.Single(r => r.Event == AuditEvents.QrLoginApproved);
        var succeeded = rows.Single(r => r.Event == AuditEvents.QrLoginSucceeded);
        approved.UserId.Should().Be(guest.UserId);
        approved.Ip.Should().Be(Phone);
        approved.UserAgent.Should().Be(PhoneAgent);
        succeeded.UserId.Should().Be(guest.UserId);
        succeeded.Ip.Should().Be(Pc);
        succeeded.UserAgent.Should().Be(PcAgent);
        approved.Detail.Should().Be(request.Id.ToString("N"));
        succeeded.Detail.Should().Be(request.Id.ToString("N"));

        // Nem o código, nem o segredo, nem o token: nada disso vai à trilha nem ao log.
        var everything = string.Join('|', (await db.LoginAudit.ToListAsync(Ct)).Select(a => $"{a.Detail}{a.Ip}{a.UserAgent}"));
        foreach (var secretText in new[] { code, secret, access })
        {
            everything.Should().NotContain(secretText);
            app.Logs.Lines.Should().NotContain(l => l.Contains(secretText, StringComparison.Ordinal), "segredo nenhum pode ir para o log");
        }
    }

    [Fact]
    public async Task OnlyHashesAreStored_NeverTheCodeOrThePollSecret()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var (code, secret, _) = await StartAsync(app);

        await using var db = app.Db();
        var request = await db.QrLoginRequests.SingleAsync(Ct);
        request.CodeHash.Should().HaveCount(32);
        request.PollSecretHash.Should().HaveCount(32);
        Convert.ToBase64String(request.CodeHash).Should().NotContain(code);
        Convert.ToBase64String(request.PollSecretHash).Should().NotContain(secret);
        request.RequesterIp.Should().Be(Pc);
        request.RequesterUserAgent.Should().Be(PcAgent);
    }

    [Fact]
    public async Task Poll_WithAWrongSecret_LooksLikeAnExpiredOne_AndAMalformedOneIsRefused()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var (_, realSecret, _) = await StartAsync(app);
        var guess = IdentityApp.NewKey().Replace('+', '-').Replace('/', '_').TrimEnd('=');

        var wrong = await PollAsync(app, guess);
        wrong.GetProperty("status").GetString().Should().Be("expired");

        using var malformed = await PollRawAsync(app, "curto");
        malformed.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // O pedido verdadeiro segue intacto depois das tentativas.
        (await PollAsync(app, realSecret)).GetProperty("status").GetString().Should().Be("pending");
    }

    [Fact]
    public async Task Poll_AfterApproval_WithAnotherSecretOrTheCode_NeverReceivesTheSession()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);
        var (_, otherSecret, _) = await StartAsync(app, "203.0.113.99");
        (await ApproveAsync(app, guest.Login.AccessToken, code)).Dispose();

        // O código do QR (que qualquer um que veja a tela conhece) não é segredo de consulta.
        using var withCode = await PollRawAsync(app, code);
        withCode.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await PollAsync(app, otherSecret)).GetProperty("status").GetString().Should().Be("pending");
        IdentityApp.Cookies(await PollRawAsync(app, otherSecret)).Should().BeEmpty();

        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("approved");
    }

    [Fact]
    public async Task InfoApproveAndDeny_WithoutASession_Return401_AndNothingChanges()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var (code, secret, _) = await StartAsync(app);

        (await InfoAsync(app, null, code)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await ApproveAsync(app, null, code)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await DenyAsync(app, null, code)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await ApproveAsync(app, "token.invalido.aqui", code)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("pending");
    }

    [Fact]
    public async Task Approve_WithoutTheClientHeader_IsRefused()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);

        using var approve = await app.SendAsync(
            HttpMethod.Post, QrRoutes.Approve, new { code }, guest.Login.AccessToken, clientHeader: false);
        approve.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var start = await app.SendAsync(HttpMethod.Post, QrRoutes.Start, clientHeader: false);
        start.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var poll = await app.SendAsync(HttpMethod.Post, QrRoutes.Poll, new { secret }, clientHeader: false);
        poll.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("curto")]
    public async Task Approve_WithAMalformedCode_Returns400(string? code)
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);

        using var response = await ApproveAsync(app, guest.Login.AccessToken, code!);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Approve_WithAnUnknownCode_Returns410_LikeAnExpiredOne()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (_, _, _) = await StartAsync(app);

        using var response = await ApproveAsync(app, guest.Login.AccessToken, "AAAAAAAAAAAAAAAA");

        response.StatusCode.Should().Be(HttpStatusCode.Gone);
        (await InfoAsync(app, guest.Login.AccessToken, "AAAAAAAAAAAAAAAA")).StatusCode.Should().Be(HttpStatusCode.Gone);
    }

    [Fact]
    public async Task Expiry_PollAndApproveAfterTheWindow_SeeAnExpiredRequest()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);

        app.Time.Advance(TimeSpan.FromSeconds(119));
        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("pending");
        app.Time.Advance(TimeSpan.FromSeconds(1));

        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("expired");
        (await ApproveAsync(app, guest.Login.AccessToken, code)).StatusCode.Should().Be(HttpStatusCode.Gone);
        (await InfoAsync(app, guest.Login.AccessToken, code)).StatusCode.Should().Be(HttpStatusCode.Gone);
    }

    [Fact]
    public async Task Start_PurgesWhatAlreadyExpired()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var (_, _, _) = await StartAsync(app);
        app.Time.Advance(TimeSpan.FromMinutes(5));

        var (_, _, _) = await StartAsync(app, "203.0.113.77");

        await using var db = app.Db();
        (await db.QrLoginRequests.CountAsync(Ct)).Should().Be(1, "o pedido vencido foi apagado na abertura do novo");
    }

    [Fact]
    public async Task Approval_GivesThePcAFreshWindowToCollect_EvenWhenTheQrWasAboutToExpire()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);

        app.Time.Advance(TimeSpan.FromSeconds(118));
        (await ApproveAsync(app, guest.Login.AccessToken, code)).StatusCode.Should().Be(HttpStatusCode.NoContent);

        app.Time.Advance(TimeSpan.FromSeconds(30));
        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("approved");
    }

    [Fact]
    public async Task Approval_NotCollectedWithinTheWindow_Expires()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);
        (await ApproveAsync(app, guest.Login.AccessToken, code)).Dispose();

        app.Time.Advance(TimeSpan.FromSeconds(61));

        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("expired");
    }

    [Fact]
    public async Task Deny_TellsThePc_AndTheRequestCanNoLongerBeApproved()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);

        using var deny = await DenyAsync(app, guest.Login.AccessToken, code);
        deny.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var poll = await PollAsync(app, secret);
        poll.GetProperty("status").GetString().Should().Be("denied");
        (await ApproveAsync(app, guest.Login.AccessToken, code)).StatusCode.Should().Be(HttpStatusCode.Gone);

        await using var db = app.Db();
        var denied = await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.QrLoginDenied, Ct);
        denied.UserId.Should().Be(guest.UserId);
        denied.Ip.Should().Be(Phone);
        (await db.RefreshTokens.CountAsync(t => t.UserId == guest.UserId, Ct)).Should().Be(1, "nenhuma sessão nova nasceu");
    }

    [Fact]
    public async Task TwoApprovals_OnlyOneWins_AndAnApprovalAfterADenialFails()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, _, _) = await StartAsync(app);

        var results = await Task.WhenAll(
            Enumerable.Range(0, 6).Select(async _ =>
            {
                using var response = await ApproveAsync(app, guest.Login.AccessToken, code);
                return response.StatusCode;
            }));

        results.Count(s => s == HttpStatusCode.NoContent).Should().Be(1);
        results.Count(s => s == HttpStatusCode.Gone).Should().Be(5);
        await using var db = app.Db();
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.QrLoginApproved, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ConcurrentPolls_DeliverTheSessionExactlyOnce()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);
        (await ApproveAsync(app, guest.Login.AccessToken, code)).Dispose();

        var statuses = await Task.WhenAll(
            Enumerable.Range(0, 8).Select(async _ =>
            {
                using var response = await PollRawAsync(app, secret);
                var body = await IdentityApp.JsonAsync(response);
                return (Status: body.GetProperty("status").GetString(), Cookies: IdentityApp.Cookies(response).Count);
            }));

        statuses.Count(s => s.Status == "approved").Should().Be(1, "só uma consulta recebe a sessão");
        statuses.Sum(s => s.Cookies).Should().Be(1, "só uma sessão nasceu");
        statuses.Where(s => s.Status != "approved").Should().OnlyContain(s => s.Status == "expired");

        await using var db = app.Db();
        (await db.RefreshTokens.Where(t => t.UserId == guest.UserId).Select(t => t.FamilyId).Distinct().CountAsync(Ct))
            .Should().Be(2, "a família do celular e a UMA do computador");
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.QrLoginSucceeded, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task AccountRevokedBetweenApprovalAndCollection_DoesNotGetASession()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);
        (await ApproveAsync(app, guest.Login.AccessToken, code)).Dispose();

        await using (var db = app.Db())
        {
            var now = app.Time.GetUtcNow();
            await db.Users.Where(u => u.Id == guest.UserId).ExecuteUpdateAsync(s => s.SetProperty(u => u.DisabledAt, now), Ct);
        }

        using var poll = await PollRawAsync(app, secret);
        var body = await IdentityApp.JsonAsync(poll);
        body.GetProperty("status").GetString().Should().Be("denied");
        IdentityApp.Cookies(poll).Should().BeEmpty();
    }

    [Fact]
    public async Task OldSessionWithoutPasskey_NeedsThePassword_AFreshOneDoesNot()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);

        // Passados 5 minutos a sessão do celular já não é "recente" (o JWT de 10 min ainda vale).
        app.Time.Advance(TimeSpan.FromMinutes(6));
        (code, secret, _) = await StartAsync(app);

        using var info = await InfoAsync(app, guest.Login.AccessToken, code);
        (await IdentityApp.JsonAsync(info)).GetProperty("verification").GetString().Should().Be("password");

        using var noPassword = await ApproveAsync(app, guest.Login.AccessToken, code);
        noPassword.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await IdentityApp.JsonAsync(noPassword)).GetProperty("type").GetString().Should().EndWith("/qr-reauth-required");

        using var wrong = await ApproveAsync(app, guest.Login.AccessToken, code, "senha-errada-123");
        wrong.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await IdentityApp.JsonAsync(wrong)).GetProperty("type").GetString().Should().EndWith("/invalid-password");
        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("pending", "a senha errada não aprova nada");

        using var right = await ApproveAsync(app, guest.Login.AccessToken, code, guest.Password);
        right.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("approved");

        await using var db = app.Db();
        var failed = await db.LoginAudit.SingleAsync(a => a.Event == AuditEvents.LoginFailed, Ct);
        failed.UserId.Should().Be(guest.UserId);
        failed.Detail.Should().Be("qr-login");
        (await db.Users.SingleAsync(u => u.Id == guest.UserId, Ct)).FailedLoginCount.Should().Be(0, "o acerto zera o contador");
    }

    [Fact]
    public async Task WrongPasswordOnApproval_CountsTowardsTheSameLockoutAsTheLogin()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options(new Dictionary<string, string?> { ["RateLimiting:qr-decide:Permitted"] = "100000" }));
        var guest = await NewGuestAsync(app);
        app.Time.Advance(TimeSpan.FromMinutes(6));
        var (code, secret, _) = await StartAsync(app);

        for (var i = 0; i < 5; i++)
        {
            using var wrong = await ApproveAsync(app, guest.Login.AccessToken, code, "senha-errada-123");
            wrong.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }

        // Bloqueada: nem a senha certa passa agora, e quem chuta só prolonga a própria espera.
        using var locked = await ApproveAsync(app, guest.Login.AccessToken, code, guest.Password);
        locked.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        locked.Headers.RetryAfter.Should().NotBeNull();
        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("pending");
    }

    [Fact]
    public async Task Info_SameNetwork_ComparesTheIpOfTheTwoSides()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, _, _) = await StartAsync(app, Pc);

        using var same = await InfoAsync(app, guest.Login.AccessToken, code, Pc);
        (await IdentityApp.JsonAsync(same)).GetProperty("sameNetwork").GetBoolean().Should().BeTrue();
        using var other = await InfoAsync(app, guest.Login.AccessToken, code, Phone);
        (await IdentityApp.JsonAsync(other)).GetProperty("sameNetwork").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task LoggedOutPhone_CannotApprove_EvenWithTheShortJwtStillValid()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, _, _) = await StartAsync(app);

        (await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: guest.Login.AccessToken)).Dispose();

        using var response = await ApproveAsync(app, guest.Login.AccessToken, code);
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task LoggedOutPhone_CannotSeeOrDenyTheRequest_EvenWithTheShortJwtStillValid()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var guest = await NewGuestAsync(app);
        var (code, secret, _) = await StartAsync(app);

        (await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/logout", bearer: guest.Login.AccessToken)).Dispose();

        using var info = await InfoAsync(app, guest.Login.AccessToken, code);
        info.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        using var deny = await DenyAsync(app, guest.Login.AccessToken, code);
        deny.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // Nada mudou: o pedido segue aberto para quem tem a sessão viva.
        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("pending");
    }

    [Fact]
    public async Task Start_IsRateLimitedPerIp()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options(new Dictionary<string, string?> { ["RateLimiting:qr-start:Permitted"] = "3" }));

        for (var i = 0; i < 3; i++)
        {
            await StartAsync(app);
        }

        using var blocked = await app.SendAsync(HttpMethod.Post, QrRoutes.Start, forwardedFor: Pc, userAgent: PcAgent);
        blocked.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        blocked.Headers.RetryAfter.Should().NotBeNull();

        // Outro IP tem balde próprio.
        await StartAsync(app, "203.0.113.88");
    }

    [Fact]
    public async Task Poll_IsRateLimitedPerIp()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options(new Dictionary<string, string?> { ["RateLimiting:qr-poll:Permitted"] = "2" }));
        var (_, secret, _) = await StartAsync(app);

        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("pending");
        (await PollAsync(app, secret)).GetProperty("status").GetString().Should().Be("pending");

        using var blocked = await PollRawAsync(app, secret);
        blocked.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task Decisions_AreRateLimitedPerAccount()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options(new Dictionary<string, string?> { ["RateLimiting:qr-decide:Permitted"] = "2" }));
        var guest = await NewGuestAsync(app);
        var (code, _, _) = await StartAsync(app);

        (await InfoAsync(app, guest.Login.AccessToken, code)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await InfoAsync(app, guest.Login.AccessToken, code)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await InfoAsync(app, guest.Login.AccessToken, code)).StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task Start_StopsAtTheCeilingOfOpenRequests()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options(new Dictionary<string, string?> { ["Modules:Identity:QrMaxPending"] = "2" }));

        await StartAsync(app, "203.0.113.1");
        await StartAsync(app, "203.0.113.2");

        using var blocked = await app.SendAsync(HttpMethod.Post, QrRoutes.Start, forwardedFor: "203.0.113.3", userAgent: PcAgent);
        blocked.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);

        // O que vence libera lugar.
        app.Time.Advance(TimeSpan.FromMinutes(3));
        await StartAsync(app, "203.0.113.3");
    }

    [Fact]
    public async Task OwnerWithoutPasskey_OnAFreshSession_AlsoConfirmsWithoutAnyExtraStep()
    {
        await using var app = await IdentityApp.StartAsync(postgres, Options());
        var owner = await app.LoginAsync();
        var (code, secret, _) = await StartAsync(app);

        using var approve = await ApproveAsync(app, owner.AccessToken, code);
        approve.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var poll = await PollRawAsync(app, secret);
        var access = (await IdentityApp.JsonAsync(poll)).GetProperty("accessToken").GetString()!;
        using var me = await app.GetAsync("/api/v1/identity/me", bearer: access);
        (await IdentityApp.JsonAsync(me)).GetProperty("role").GetString().Should().Be("owner");
    }
}

/// <summary>As rotas do QR, num lugar só.</summary>
internal static class QrRoutes
{
    public const string Start = "/api/v1/identity/auth/qr/start";
    public const string Poll = "/api/v1/identity/auth/qr/poll";
    public const string Info = "/api/v1/identity/auth/qr/info";
    public const string Approve = "/api/v1/identity/auth/qr/approve";
    public const string Deny = "/api/v1/identity/auth/qr/deny";
}
