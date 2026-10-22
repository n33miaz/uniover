using System.Text.Json;
using AwesomeAssertions;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using static UniOver.IntegrationTests.Audit.AuditKit;

namespace UniOver.IntegrationTests.Audit;

/// <summary>
/// Tentativa contra uma conta feita por alguém SEM login (senha errada, conta bloqueada, convidado revogado, refresh
/// reutilizado): na trilha o ator é nulo e a conta atingida é o ALVO. Sem isso, um ataque de senha contra a conta do
/// dono apareceria como "a conta do dono tentou entrar e errou". Prova de ponta a ponta, pela rota do administrador, com
/// o filtro por pessoa casando o ator OU o alvo.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class AttemptsAgainstAnAccountTests(PostgresFixture postgres)
{
    private const string WrongPassword = "errada-errada";

    private static List<JsonElement> Items(JsonElement page) => [.. page.GetProperty("items").EnumerateArray()];

    private async Task<(IdentityApp App, string Token, Guid OwnerId)> StartAsync()
    {
        var database = await MigratedDatabaseAsync(postgres);
        var app = await StartAppAsync(postgres, database, forwardedHeaders: true);
        var owner = await app.LoginAsync();
        return (app, owner.AccessToken, await OwnerIdAsync(app));
    }

    private static async Task<JsonElement> OnlyAsync(IdentityApp app, string token, string query)
    {
        var page = await GetJsonAsync(app, token, query);
        return Items(page).Should().ContainSingle().Subject;
    }

    [Fact]
    public async Task AWrongPassword_IsRecordedAgainstTheAccount_NeverByIt_AndThePersonFilterFindsIt()
    {
        var (app, token, ownerId) = await StartAsync();
        await using var lifetime = app;

        (await app.LoginRawAsync(app.OwnerEmail, WrongPassword, "203.0.113.8", "navegador-do-atacante/1.0")).Dispose();
        (await app.LoginRawAsync("ninguem@uniover.test", WrongPassword, "203.0.113.9")).Dispose();

        var attempt = await OnlyAsync(app, token, $"?action=login_failed&person={ownerId}");

        attempt.GetProperty("actor").ValueKind.Should().Be(JsonValueKind.Null, "quem errou a senha não está autenticado");
        attempt.GetProperty("targetAccount").GetProperty("id").GetGuid().Should().Be(ownerId);
        attempt.GetProperty("outcome").GetString().Should().Be("failure");
        attempt.GetProperty("detail").ValueKind.Should().Be(JsonValueKind.Null, "o id da conta não aparece como detalhe");
        attempt.GetProperty("ip").GetString().Should().Be("203.0.113.8", "o IP segue gravado");
        attempt.GetProperty("userAgent").GetString().Should().Be("navegador-do-atacante/1.0");

        // O e-mail desconhecido não aponta conta nenhuma e não aparece no filtro da pessoa.
        var all = Items(await GetJsonAsync(app, token, "?action=login_failed"));
        all.Should().HaveCount(2);
        var unknown = all.Single(i => i.GetProperty("ip").GetString() == "203.0.113.9");
        unknown.GetProperty("actor").ValueKind.Should().Be(JsonValueKind.Null);
        unknown.GetProperty("targetAccount").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task RowsWrittenBeforeTheFix_KeepTheAccountAsTheAuthor_AndStayInThePersonFilter()
    {
        var (app, token, ownerId) = await StartAsync();
        await using var lifetime = app;
        var at = new DateTimeOffset(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);
        await AddAsync(app.Database, LoginAuditEntry.Create(ownerId, AuditEvents.LoginFailed, at, "198.51.100.1", "navegador/1.0"));
        (await app.LoginRawAsync(app.OwnerEmail, WrongPassword, "203.0.113.8")).Dispose();

        var items = Items(await GetJsonAsync(app, token, $"?action=login_failed&person={ownerId}"));

        items.Should().HaveCount(2, "a linha antiga (conta como autora) e a nova (conta como alvo) casam o mesmo filtro");
        var old = items.Single(i => i.GetProperty("ip").GetString() == "198.51.100.1");
        old.GetProperty("actor").GetProperty("id").GetGuid().Should().Be(ownerId, "a trilha é só de inclusão: a linha antiga não é reescrita");
        old.GetProperty("targetAccount").ValueKind.Should().Be(JsonValueKind.Null);
        var current = items.Single(i => i.GetProperty("ip").GetString() == "203.0.113.8");
        current.GetProperty("actor").ValueKind.Should().Be(JsonValueKind.Null);
        current.GetProperty("targetAccount").GetProperty("id").GetGuid().Should().Be(ownerId);
    }

    [Fact]
    public async Task ALockedAccount_IsRecordedAsDenied_AgainstTheAccount_WithNoActor()
    {
        var (app, token, ownerId) = await StartAsync();
        await using var lifetime = app;
        for (var i = 0; i < 5; i++)
        {
            (await app.LoginRawAsync(app.OwnerEmail, WrongPassword, "203.0.113.8")).Dispose();
        }

        (await app.LoginRawAsync(app.OwnerEmail, app.OwnerPassword, "203.0.113.20")).Dispose();

        var locked = await OnlyAsync(app, token, $"?action=login_locked&person={ownerId}");
        locked.GetProperty("actor").ValueKind.Should().Be(JsonValueKind.Null);
        locked.GetProperty("targetAccount").GetProperty("id").GetGuid().Should().Be(ownerId);
        locked.GetProperty("outcome").GetString().Should().Be("denied");
        locked.GetProperty("ip").GetString().Should().Be("203.0.113.20");

        var failures = Items(await GetJsonAsync(app, token, $"?action=login_failed&person={ownerId}"));
        failures.Should().HaveCount(5);
        failures.Should().OnlyContain(i => i.GetProperty("actor").ValueKind == JsonValueKind.Null);
    }

    [Fact]
    public async Task ARevokedGuestsLogin_KeepsTheReason_AgainstTheGuestAccount_WithNoActor()
    {
        var (app, token, _) = await StartAsync();
        await using var lifetime = app;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Alice", AccessPermissions.All);
        await ExecuteAsync(app.Database.OwnerConnection, $"UPDATE identity.users SET disabled_at = now() WHERE id = '{guest.UserId}'");

        (await app.LoginRawAsync(guest.Email, guest.Password, "203.0.113.30")).Dispose();

        var attempt = await OnlyAsync(app, token, $"?action=login_failed&person={guest.UserId}");
        attempt.GetProperty("actor").ValueKind.Should().Be(JsonValueKind.Null);
        attempt.GetProperty("targetAccount").GetProperty("id").GetGuid().Should().Be(guest.UserId);
        attempt.GetProperty("targetAccount").GetProperty("displayName").GetString().Should().Be("Alice");
        attempt.GetProperty("detail").GetString().Should().Be("account-disabled");
    }

    [Fact]
    public async Task AReusedRefreshToken_IsRecordedAgainstTheAccount_WithNoActor()
    {
        var (app, token, ownerId) = await StartAsync();
        await using var lifetime = app;
        var login = await app.LoginAsync();
        (await app.RefreshRawAsync(login.RefreshSecret)).Dispose();
        app.Time.Advance(TimeSpan.FromSeconds(4));

        (await app.RefreshRawAsync(login.RefreshSecret)).Dispose();

        var reuse = (await GetJsonAsync(app, token, $"?action=refresh_reuse_detected&person={ownerId}"))
            .GetProperty("items").EnumerateArray().First();
        reuse.GetProperty("actor").ValueKind.Should().Be(JsonValueKind.Null);
        reuse.GetProperty("targetAccount").GetProperty("id").GetGuid().Should().Be(ownerId);
        reuse.GetProperty("outcome").GetString().Should().Be("denied");
    }
}
