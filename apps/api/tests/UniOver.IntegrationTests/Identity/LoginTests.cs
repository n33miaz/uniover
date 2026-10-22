using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class LoginTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Login_WithTheRightPassword_ReturnsShortJwtAndSecureRefreshCookie()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var response = await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(response);
        body.GetProperty("expiresIn").GetInt32().Should().Be(600);

        var jwt = new JsonWebTokenHandler().ReadJsonWebToken(body.GetProperty("accessToken").GetString());
        jwt.Issuer.Should().Be("uniover");
        jwt.Audiences.Should().Equal("uniover-api");
        jwt.Alg.Should().Be("HS256");
        jwt.Kid.Should().NotBeNullOrEmpty();
        jwt.GetClaim("sub").Value.Should().NotBeNullOrEmpty();
        jwt.GetClaim("sid").Value.Should().NotBeNullOrEmpty();
        jwt.GetClaim("jti").Value.Should().NotBeNullOrEmpty();
        (jwt.ValidTo - jwt.ValidFrom).Should().Be(TimeSpan.FromMinutes(10));

        var cookie = IdentityApp.Cookies(response).Should().ContainSingle().Which;
        cookie.Name.Should().Be("uo_rt");
        cookie.Has("httponly").Should().BeTrue();
        cookie.Has("secure").Should().BeTrue();
        cookie.Get("samesite").Should().Be("strict");
        cookie.Get("path").Should().Be("/api/v1/identity/auth");
        cookie.Get("max-age").Should().Be(TimeSpan.FromDays(14).TotalSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
        cookie.Value.Should().NotContain(".", "o refresh é um segredo opaco, não um JWT");

        // Só o hash do segredo vai para o banco.
        await using var db = app.Db();
        var stored = await db.RefreshTokens.SingleAsync(Ct);
        stored.TokenHash.Should().HaveCount(32);
        Convert.ToBase64String(stored.TokenHash).Should().NotContain(cookie.Value);
    }

    [Fact]
    public async Task Login_SendsTheTokenInTheBodyOnly_NeverInAnotherCookieOrHeader()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var response = await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword);

        IdentityApp.Cookies(response).Select(c => c.Name).Should().Equal("uo_rt");
        response.Headers.Contains("Authorization").Should().BeFalse();
        response.Headers.Location.Should().BeNull();
    }

    [Fact]
    public async Task Login_WithWrongPasswordOrUnknownEmail_AnswersTheSameGeneric401()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var wrongPassword = await app.LoginRawAsync(app.OwnerEmail, "senha-errada-123");
        using var unknownEmail = await app.LoginRawAsync("ninguem@uniover.test", "senha-errada-123");

        wrongPassword.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        unknownEmail.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var a = await IdentityApp.JsonAsync(wrongPassword);
        var b = await IdentityApp.JsonAsync(unknownEmail);
        a.GetProperty("title").GetString().Should().Be(b.GetProperty("title").GetString());
        a.GetProperty("type").GetString().Should().Be(b.GetProperty("type").GetString());
        a.GetProperty("status").GetInt32().Should().Be(b.GetProperty("status").GetInt32());
        IdentityApp.Cookies(wrongPassword).Should().BeEmpty();
        IdentityApp.Cookies(unknownEmail).Should().BeEmpty();
    }

    [Fact]
    public async Task Login_IsCaseAndSpaceInsensitiveOnTheEmail()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var response = await app.LoginRawAsync("  DONO@Uniover.TEST ", app.OwnerPassword);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Login_WithoutTheClientHeader_Returns400()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var response = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/login", new { email = app.OwnerEmail, password = app.OwnerPassword }, clientHeader: false);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        IdentityApp.Cookies(response).Should().BeEmpty();
    }

    [Theory]
    [InlineData(null, "senha")]
    [InlineData("nao-e-email", "senha")]
    [InlineData("dono@uniover.test", null)]
    [InlineData("dono@uniover.test", "")]
    public async Task Login_WithInvalidFields_Returns400WithFieldErrors(string? email, string? password)
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var response = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/login", new { email, password });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await IdentityApp.JsonAsync(response)).GetProperty("errors").EnumerateObject().Should().NotBeEmpty();
    }

    [Fact]
    public async Task Login_AuditsSuccessFailureAndUnknownEmail_WithIpAndTruncatedUserAgent()
    {
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { ForwardedHeaders = true });
        var longAgent = new string('a', 400);

        (await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword, "203.0.113.7", longAgent)).Dispose();
        (await app.LoginRawAsync(app.OwnerEmail, "errada-errada", "203.0.113.8")).Dispose();
        (await app.LoginRawAsync("ninguem@uniover.test", "errada-errada", "203.0.113.9")).Dispose();

        await using var db = app.Db();
        var owner = await db.Users.SingleAsync(Ct);
        var entries = await db.LoginAudit.Where(a => a.Event != AuditEvents.OwnerCreated).OrderBy(a => a.OccurredAt).ThenBy(a => a.Id).ToListAsync(Ct);

        entries.Should().HaveCount(3);
        var success = entries.Single(e => e.Event == AuditEvents.LoginSucceeded);
        success.UserId.Should().Be(owner.Id);
        success.Ip.Should().Be("203.0.113.7");
        success.UserAgent.Should().HaveLength(256, "o User-Agent é truncado");

        // Quem errou a senha não está autenticado: o ator é nulo nas duas, e a conta (quando existe) é o ALVO, no detalhe.
        entries.Where(e => e.Event == AuditEvents.LoginFailed).Should().OnlyContain(e => e.UserId == null);
        entries.Single(e => e.Event == AuditEvents.LoginFailed && e.Detail == AuditAboutAccount.Detail(owner.Id)).Ip.Should().Be("203.0.113.8");
        entries.Single(e => e.Event == AuditEvents.LoginFailed && e.Detail == null).Ip.Should().Be("203.0.113.9");
    }

    [Fact]
    public async Task Lockout_AfterFiveFailures_Returns429WithGrowingRetryAfter_AndNeverChecksThePasswordWhileLocked()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        for (var i = 0; i < 5; i++)
        {
            using var failed = await app.LoginRawAsync(app.OwnerEmail, "errada-errada");
            failed.StatusCode.Should().Be(HttpStatusCode.Unauthorized, $"a falha {i + 1} ainda não bloqueia");
        }

        // Cada rodada: bloqueado (mesmo com a senha certa), espera acabar, erra de novo e o bloqueio dobra, até 15 min.
        var expected = new[] { 60, 120, 240, 480, 900, 900 };
        foreach (var seconds in expected)
        {
            using var locked = await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword);
            locked.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
            var problem = await IdentityApp.JsonAsync(locked);
            problem.GetProperty("type").GetString().Should().Be("https://uniover.app/problems/login-locked");
            locked.Headers.RetryAfter!.Delta!.Value.TotalSeconds.Should().Be(seconds);

            app.Time.Advance(TimeSpan.FromSeconds(seconds - 1));
            using var stillLocked = await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword);
            stillLocked.StatusCode.Should().Be(HttpStatusCode.TooManyRequests, "falta 1 segundo");

            app.Time.Advance(TimeSpan.FromSeconds(1));
            using var failedAgain = await app.LoginRawAsync(app.OwnerEmail, "errada-errada");
            failedAgain.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        }

        await using var db = app.Db();
        var ownerId = (await db.Users.SingleAsync(Ct)).Id;
        (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.LoginLocked && a.UserId == null && a.Detail == AuditAboutAccount.Detail(ownerId), Ct))
            .Should().BeGreaterThan(0, "o bloqueio registra a conta como alvo, com o ator nulo");
        (await db.LoginAudit.CountAsync(a => (a.Event == AuditEvents.LoginLocked || a.Event == AuditEvents.LoginFailed) && a.UserId != null, Ct))
            .Should().Be(0, "a conta atacada nunca aparece como autora do ataque");
    }

    [Fact]
    public async Task Lockout_SurvivesAProcessRestart_BecauseItLivesInTheDatabase()
    {
        var start = new DateTimeOffset(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);
        await using var first = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { Start = start });
        for (var i = 0; i < 5; i++)
        {
            (await first.LoginRawAsync(first.OwnerEmail, "errada-errada")).Dispose();
        }

        // Instância nova, contadores em memória zerados, mesmo banco.
        await using var second = await IdentityApp.StartAsync(postgres, new IdentityAppOptions
        {
            Database = first.Database,
            OwnerEmail = null,
            Start = start.AddSeconds(30),
        });

        using var locked = await second.LoginRawAsync(first.OwnerEmail, first.OwnerPassword);

        locked.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        locked.Headers.RetryAfter!.Delta!.Value.TotalSeconds.Should().Be(30);

        second.Time.Advance(TimeSpan.FromSeconds(31));
        using var released = await second.LoginRawAsync(first.OwnerEmail, first.OwnerPassword);
        released.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Lockout_IsClearedByASuccessfulLogin()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        for (var i = 0; i < 4; i++)
        {
            (await app.LoginRawAsync(app.OwnerEmail, "errada-errada")).Dispose();
        }

        (await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword)).StatusCode.Should().Be(HttpStatusCode.OK);

        // Se o contador não tivesse zerado, a quinta falha acumulada já bloquearia.
        for (var i = 0; i < 4; i++)
        {
            using var failed = await app.LoginRawAsync(app.OwnerEmail, "errada-errada");
            failed.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        }

        await using var db = app.Db();
        var owner = await db.Users.SingleAsync(Ct);
        owner.FailedLoginCount.Should().Be(4);
        owner.LockoutUntil.Should().BeNull();
    }

    [Fact]
    public async Task OwnerAccount_NeverAsksForAPasswordChange()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        // Passados 200 dias, sem qualquer troca, a senha continua valendo e nada na resposta pede para trocá-la.
        app.Time.Advance(TimeSpan.FromDays(200));
        using var response = await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(response);
        body.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(["accessToken", "expiresIn"]);
    }
}
