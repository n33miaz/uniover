using System.Net;
using System.Net.Http.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// A convidada que já existia antes das permissões. A conta é gravada no esquema ANTIGO, as migrations novas rodam (e o
/// backfill dá a ela o que ela tinha) e só então o Host sobe: o teste atravessa o caminho inteiro (migration, banco, cache,
/// política, rota) e prova que ela alcança exatamente o que alcançava e segue recusada onde era recusada.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TvLegacyGuestTests(PostgresFixture postgres)
{
    private const string LegacyEmail = "alice@uniover.test";

    private static readonly Guid LegacyId = Guid.Parse("0192f1e4-0000-7000-8000-0000000000a2");

    private static readonly string LegacyPassword = "convidada-" + Guid.NewGuid().ToString("N");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>O que ela alcançava antes: a TV inteira (teclas, texto, acordar, limpar, desligar, abrir apps, atualizar, histórico).</summary>
    private static readonly (string Method, string Url, object? Body, bool Reached)[] BeforeThePermissions =
    [
        ("GET", "/api/v1/tv/state", null, true),
        ("GET", "/api/v1/tv/shortcuts", null, true),
        ("POST", "/api/v1/tv/keys", new { key = "HOME" }, true),
        ("POST", "/api/v1/tv/text", new { text = "filme" }, true),
        ("POST", "/api/v1/tv/wake", null, true),
        ("POST", "/api/v1/tv/cleanup", null, true),
        ("POST", "/api/v1/tv/power/off", null, true),
        ("POST", "/api/v1/tv/shortcuts/0192f1e4-0000-7000-8000-0000000000d1/launch", null, true),
        ("POST", "/api/v1/tv/shortcuts/refresh", null, true),
        ("GET", "/api/v1/tv/commands/recent", null, true),

        // E onde ela era recusada: renomear, ocultar e reordenar atalhos, e tudo fora da TV.
        ("PATCH", "/api/v1/tv/shortcuts/0192f1e4-0000-7000-8000-0000000000d1", new { customLabel = "Meu app" }, false),
        ("PUT", "/api/v1/tv/shortcuts/order", new { ids = new[] { Guid.Parse("0192f1e4-0000-7000-8000-0000000000d1") } }, false),
        ("GET", "/api/v1/devices/agents", null, false),
        ("GET", "/api/v1/training/exercises", null, false),
        ("GET", "/api/v1/identity/guests", null, false),
        ("GET", "/api/v1/identity/passkeys", null, false),
    ];

    /// <summary>O modelo "TV inteira sem editar atalhos", por extenso e na ordem do catálogo.</summary>
    private static readonly string[] WhatSheHadToday = ["module:tv", "tv:control", "tv:power", "tv:launch", "tv:history"];

    private static async Task SeedTheOldSchemaAsync(IdentityDbContext context)
    {
        // A senha de hoje é a que o teste conhece: o hash vem do mesmo serviço que a API usa no login.
        var hash = new PasswordService().Hash(LegacyPassword);
        var createdAt = new DateTimeOffset(2026, 10, 19, 10, 0, 0, TimeSpan.Zero);
        await context.Database.ExecuteSqlAsync(
            $"INSERT INTO identity.users (id, email, display_name, password_hash, created_at, failed_login_count, role, disabled_at) VALUES ({LegacyId}, {LegacyEmail}, {"Alice"}, {hash}, {createdAt}, 0, 'guest', NULL)",
            Ct);
    }

    private static async Task<LoggedIn> LoginAsync(TvApp app)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/login")
        {
            Content = JsonContent.Create(new { email = LegacyEmail, password = LegacyPassword }),
        };
        request.Headers.Add(IdentityApp.ClientHeader, "web");
        using var response = await app.Client.SendAsync(request, Ct);
        return await GuestSeed.ReadLoginAsync(response);
    }

    [Fact]
    public async Task TheGuestThatExistedBeforeThePermissions_ReachesWhatSheReached_AndIsRefusedWhereSheWas()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { SeedBeforeGrants = SeedTheOldSchemaAsync });
        app.PassReconnectGrace();
        var login = await LoginAsync(app);

        // O backfill deu a ela, exatamente, o que ela tinha (e nada de editar atalhos).
        await using (var db = app.Identity())
        {
            var stored = await db.UserGrants.Where(g => g.UserId == LegacyId).Select(g => g.Permission).ToListAsync(Ct);
            stored.Order(StringComparer.Ordinal).Should().Equal(WhatSheHadToday.Order(StringComparer.Ordinal));
        }

        var mistakes = new List<string>();
        foreach (var (method, url, body, reached) in BeforeThePermissions)
        {
            using var response = await app.SendAsync(new HttpMethod(method), url, body, login.AccessToken);
            if (TvPermissionMap.Reached(response.StatusCode) != reached || (!reached && response.StatusCode != HttpStatusCode.Forbidden))
            {
                mistakes.Add($"{method} {url}: respondeu {(int)response.StatusCode} e {(reached ? "devia alcançar" : "devia ser 403")}");
            }
        }

        mistakes.Should().BeEmpty();

        // O fluxo ao vivo também abre para ela.
        using var stream = await app.OpenEventsAsync(await app.StreamTicketAsync(login.AccessToken));
        stream.StatusCode.Should().Be(HttpStatusCode.OK);

        // O perfil dela mostra o mesmo conjunto, e uma convidada nova pelo convite padrão recebe exatamente o mesmo.
        var newcomer = await app.NewGuestAsync("Nova", null, 60);
        (await PermissionsOfAsync(app, login.AccessToken)).Should().Equal(WhatSheHadToday);
        (await PermissionsOfAsync(app, newcomer.Login.AccessToken)).Should().Equal(WhatSheHadToday);
    }

    private static async Task<string[]> PermissionsOfAsync(TvApp app, string bearer)
    {
        using var me = await app.GetAsync("/api/v1/identity/me", bearer: bearer);
        me.StatusCode.Should().Be(HttpStatusCode.OK);
        return [.. (await TvApp.JsonAsync(me)).GetProperty("permissions").EnumerateArray().Select(e => e.GetString()!)];
    }
}
