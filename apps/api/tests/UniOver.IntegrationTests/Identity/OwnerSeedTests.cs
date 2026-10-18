using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity;

[Collection(PostgresGroup.Name)]
public sealed class OwnerSeedTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Seed_CreatesTheOwnerOnce_AndIgnoresASecondRunWithAnotherPassword()
    {
        await using var first = await IdentityApp.StartAsync(postgres);
        await first.Bootstrap.Completion;

        await using (var db = first.Db())
        {
            var users = await db.Users.ToListAsync(Ct);
            users.Should().ContainSingle().Which.Email.Should().Be("dono@uniover.test");
            users[0].PasswordHash.Should().NotContain(first.OwnerPassword, "só o hash vai para o banco");
            (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.OwnerCreated, Ct)).Should().Be(1);
        }

        // Reinício do processo com outra senha no ambiente: a conta existente não muda e a variável gera aviso.
        var otherPassword = IdentityApp.NewPassword();
        await using var second = await IdentityApp.StartAsync(postgres, new IdentityAppOptions
        {
            Database = first.Database,
            OwnerPassword = otherPassword,
        });
        await second.Bootstrap.Completion;

        await using (var db = second.Db())
        {
            (await db.Users.CountAsync(Ct)).Should().Be(1);
            (await db.LoginAudit.CountAsync(a => a.Event == AuditEvents.OwnerCreated, Ct)).Should().Be(1);
        }

        second.Logs.Lines.Should().Contain(l => l.Contains("UNIOVER_OWNER_PASSWORD ainda está no ambiente", StringComparison.Ordinal));
        (await second.LoginRawAsync(second.OwnerEmail, first.OwnerPassword)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await second.LoginRawAsync(second.OwnerEmail, otherPassword)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Seed_NeverLogsThePassword()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        await app.Bootstrap.Completion;

        app.Logs.Lines.Should().Contain(l => l.Contains("Conta do dono criada", StringComparison.Ordinal));
        app.Logs.Lines.Should().NotContain(l => l.Contains(app.OwnerPassword, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Seed_WithADatabaseWithoutTables_DoesNotStopTheStartup()
    {
        // Banco vazio, sem migration: as tabelas só entram pela esteira de publicação.
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { Migrate = false });
        await app.Bootstrap.Completion;

        var live = await app.GetAsync("/health/live");

        live.StatusCode.Should().Be(HttpStatusCode.OK);
        app.Logs.Lines.Should().Contain(l => l.Contains("as tabelas do módulo ainda não existem", StringComparison.Ordinal));
        app.Logs.Lines.Should().NotContain(l => l.Contains(app.OwnerPassword, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Seed_WithAnUnreachableDatabase_DoesNotStopTheStartup()
    {
        var extra = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = "Host=banco-inexistente.invalid;Database=d;Username=u;Password=p;Timeout=5",
        };
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { Extra = extra });
        await app.Bootstrap.Completion;

        (await app.GetAsync("/health/live")).StatusCode.Should().Be(HttpStatusCode.OK);
        app.Logs.Lines.Should().Contain(l => l.Contains("banco inacessível", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Seed_WithoutTheVariables_NeverOpensADatabaseConnection()
    {
        var extra = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = "Host=banco-inexistente.invalid;Database=d;Username=u;Password=p;Timeout=5",
        };
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { OwnerEmail = null, Extra = extra });
        await app.Bootstrap.Completion;

        app.Logs.Lines.Should().NotContain(l => l.Contains("Seed do dono", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("123456789")]
    [InlineData("")]
    public async Task Seed_RejectsAPasswordBelowTheMinimum_WithoutLoggingIt(string password)
    {
        await using var app = await IdentityApp.StartAsync(postgres, new IdentityAppOptions { OwnerPassword = password });
        await app.Bootstrap.Completion;

        await using var db = app.Db();
        (await db.Users.CountAsync(Ct)).Should().Be(0);
        app.Logs.Lines.Should().Contain(l => l.Contains("Seed do dono ignorado", StringComparison.Ordinal));
        if (password.Length > 0)
        {
            app.Logs.Lines.Should().NotContain(l => l.Contains(password, StringComparison.Ordinal));
        }
    }

    [Theory]
    [InlineData("/api/v1/identity/auth/register")]
    [InlineData("/api/v1/identity/auth/signup")]
    [InlineData("/api/v1/identity/users")]
    public async Task ThereIsNoRegistrationEndpoint(string path)
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(
            HttpMethod.Post, path, new { email = "outro@uniover.test", password = IdentityApp.NewPassword() }, bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
