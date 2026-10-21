using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Identity.Domain;
using UniOver.SharedKernel.Audit;
using static UniOver.IntegrationTests.Audit.AuditKit;

namespace UniOver.IntegrationTests.Audit;

/// <summary>
/// A trilha unificada do administrador, de ponta a ponta: Host real, Postgres real, as três fontes migradas. O que
/// a rota nunca pode fazer (devolver e-mail, aceitar convidado, perder linha na paginação) é provado aqui.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class AuditEndpointTests(PostgresFixture postgres)
{
    // Instantes fixos longe do relógio real: as linhas semeadas ficam isoladas das que os fluxos reais gravam agora.
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);
    private const string Window = "from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z";

    private static string[] Strings(JsonElement array) => [.. array.EnumerateArray().Select(e => e.GetString()!)];

    private static List<JsonElement> Items(JsonElement page) => [.. page.GetProperty("items").EnumerateArray()];

    private async Task<(IdentityApp App, LoggedIn Owner, Guid OwnerId)> StartAsync()
    {
        var database = await MigratedDatabaseAsync(postgres);
        var app = await StartAppAsync(postgres, database);
        var owner = await app.LoginAsync();
        return (app, owner, await OwnerIdAsync(app));
    }

    [Fact]
    public async Task Owner_ReadsTheThreeSources_NewestFirst_WithIpAndDevice_ButNeverTheEmail()
    {
        var (app, owner, ownerId) = await StartAsync();
        await using var lifetime = app;
        var agentId = Guid.NewGuid();
        var pairingId = Guid.NewGuid();
        await AddAgentAsync(app.Database, Agent.Create(agentId, "pc-sala", "Computador da sala", "windows", ownerId, T0));
        await AddAsync(app.Database, LoginAuditEntry.Create(ownerId, AuditEvents.LoginFailed, T0.AddMinutes(1), "198.51.100.1", "navegador/1.0", "account-disabled"));
        await AddAsync(app.Database, PairingAuditEntry.Create(PairingEvents.Approved, agentId, pairingId, ownerId, "198.51.100.9", "agente/2.0", T0.AddMinutes(2)));
        await AddAsync(app.Database, Command(ownerId, "tv.key", "VOLUME_UP", true, T0.AddMinutes(3)));

        var page = await GetJsonAsync(app, owner.AccessToken, "?" + Window);

        var items = Items(page);
        items.Select(i => i.GetProperty("module").GetString()).Should().Equal("tv", "devices", "identity");
        page.GetProperty("nextCursor").ValueKind.Should().Be(JsonValueKind.Null);

        var tv = items[0];
        tv.GetProperty("action").GetString().Should().Be("tv.key");
        tv.GetProperty("outcome").GetString().Should().Be("success");
        tv.GetProperty("target").GetString().Should().Be("VOLUME_UP");
        tv.GetProperty("ip").GetString().Should().Be("203.0.113.5");
        tv.GetProperty("userAgent").GetString().Should().Be("UA-tv");
        tv.GetProperty("actor").GetProperty("id").GetGuid().Should().Be(ownerId);
        tv.GetProperty("actor").GetProperty("displayName").GetString().Should().NotBeNullOrWhiteSpace();

        var devices = items[1];
        devices.GetProperty("action").GetString().Should().Be("pairing_approved");
        devices.GetProperty("target").GetString().Should().Be("Computador da sala");
        devices.GetProperty("ip").GetString().Should().Be("198.51.100.9");

        var identity = items[2];
        identity.GetProperty("action").GetString().Should().Be("login_failed");
        identity.GetProperty("outcome").GetString().Should().Be("failure");
        identity.GetProperty("detail").GetString().Should().Be("account-disabled");
        identity.GetProperty("userAgent").GetString().Should().Be("navegador/1.0");

        using var raw = await GetAsync(app, owner.AccessToken, "?limit=200");
        var body = await raw.Content.ReadAsStringAsync(Ct);
        body.Should().NotContain(app.OwnerEmail, "o e-mail nunca sai por esta rota");
        body.Should().NotContain("passwordHash");
    }

    [Fact]
    public async Task EveryRoute_RefusesTheAnonymous_AndTheGuestEvenWithEveryPermission()
    {
        var (app, owner, _) = await StartAsync();
        await using var lifetime = app;
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Alice", AccessPermissions.All);

        foreach (var path in new[] { "", "/sources", "/export" })
        {
            using var anonymous = await app.GetAsync(Route + path);
            anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized, path);

            using var asGuest = await app.GetAsync(Route + path, guest.Login.AccessToken);
            asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden, path);

            using var asOwner = await app.GetAsync(Route + path, owner.AccessToken);
            asOwner.StatusCode.Should().Be(HttpStatusCode.OK, path);
        }
    }

    [Fact]
    public async Task Sources_ListsTheModulesWithTheirRetentionAndActions()
    {
        var (app, owner, _) = await StartAsync();
        await using var lifetime = app;

        using var response = await GetAsync(app, owner.AccessToken, path: "/sources");
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);

        var sources = body.GetProperty("sources").EnumerateArray().ToList();
        sources.Select(s => s.GetProperty("module").GetString()).Should().Equal("devices", "identity", "tv");
        sources.Select(s => s.GetProperty("retentionDays").GetInt32()).Should().Equal(
            AuditRetentionPolicy.SecurityDays, AuditRetentionPolicy.SecurityDays, AuditRetentionPolicy.CommandDays);
        Strings(sources[0].GetProperty("actions")).Should().Contain(["pairing_approved", "agent_revoked"]);
        Strings(sources[1].GetProperty("actions")).Should().Contain([AuditEvents.PermissionsChanged, AuditEvents.AuditExported]);
        Strings(sources[2].GetProperty("actions")).Should().Contain(["tv.key", "tv.shortcut.update"]);
        Strings(body.GetProperty("outcomes")).Should().Equal("success", "failure", "denied");
    }

    /// <summary>Linhas conhecidas, com atores diferentes, para os filtros: o instante de cada uma é T0 + o minuto.</summary>
    private async Task<(IdentityApp App, string Token, Guid OwnerId, Guid GuestId)> SeededAsync()
    {
        var (app, owner, ownerId) = await StartAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Alice", AccessPermissions.All);
        var agentId = Guid.NewGuid();
        await AddAgentAsync(app.Database, Agent.Create(agentId, "pc-sala", "Computador da sala", "windows", ownerId, T0));

        await AddAsync(app.Database, Command(ownerId, "tv.key", "HOME", true, T0.AddMinutes(0)));
        await AddAsync(app.Database, Command(guest.UserId, "tv.text", "length=5", false, T0.AddMinutes(1), "AgentOffline"));
        await AddAsync(app.Database, Command(guest.UserId, "tv.key", "VOLUME_UP", true, T0.AddMinutes(2)));
        await AddAsync(app.Database, PairingAuditEntry.Create(PairingEvents.Approved, agentId, Guid.NewGuid(), ownerId, "198.51.100.9", "agente/2.0", T0.AddMinutes(3)));
        await AddAsync(app.Database, PairingAuditEntry.Create(PairingEvents.Denied, null, Guid.NewGuid(), ownerId, "198.51.100.9", "agente/2.0", T0.AddMinutes(4)));
        await AddAsync(app.Database, LoginAuditEntry.Create(ownerId, AuditEvents.GuestRevoked, T0.AddMinutes(5), "198.51.100.1", "navegador/1.0", guest.UserId.ToString("N")));
        await AddAsync(app.Database, LoginAuditEntry.Create(ownerId, AuditEvents.PermissionsChanged, T0.AddMinutes(6), "198.51.100.1", "navegador/1.0", $"{guest.UserId:N}|+tv:power|-"));
        await AddAsync(app.Database, LoginAuditEntry.Create(null, AuditEvents.LoginFailed, T0.AddMinutes(7), "192.0.2.50", "curl/8", null));
        await AddAsync(app.Database, LoginAuditEntry.Create(ownerId, AuditEvents.LoginLocked, T0.AddMinutes(8), "192.0.2.51", "curl/8", null));
        return (app, owner.AccessToken, ownerId, guest.UserId);
    }

    private static string[] ActionsOf(JsonElement page) => [.. Items(page).Select(i => i.GetProperty("action").GetString()!)];

    [Fact]
    public async Task Filters_ByModule_Action_Outcome_AndPeriod_Combine()
    {
        var (app, token, _, _) = await SeededAsync();
        await using var lifetime = app;

        ActionsOf(await GetJsonAsync(app, token, $"?{Window}")).Should().HaveCount(9);
        (await GetJsonAsync(app, token, $"?{Window}&module=tv")).GetProperty("items").GetArrayLength().Should().Be(3);
        (await GetJsonAsync(app, token, $"?{Window}&module=tv&module=devices")).GetProperty("items").GetArrayLength().Should().Be(5);

        ActionsOf(await GetJsonAsync(app, token, $"?{Window}&action=tv.key")).Should().Equal("tv.key", "tv.key");
        ActionsOf(await GetJsonAsync(app, token, $"?{Window}&action=tv.key&action=tv.text")).Should().HaveCount(3);
        ActionsOf(await GetJsonAsync(app, token, $"?{Window}&action=pairing_denied")).Should().Equal("pairing_denied");

        ActionsOf(await GetJsonAsync(app, token, $"?{Window}&outcome=failure")).Should().BeEquivalentTo("tv.text", "login_failed");
        ActionsOf(await GetJsonAsync(app, token, $"?{Window}&outcome=denied")).Should().BeEquivalentTo("pairing_denied", "login_locked");
        ActionsOf(await GetJsonAsync(app, token, $"?{Window}&outcome=success")).Should().HaveCount(5);

        // Semiaberto: o início entra, o fim não (a linha das 12:04 é o pareamento negado).
        var span = await GetJsonAsync(app, token, "?from=2026-10-01T12:02:00Z&to=2026-10-01T12:04:00Z");
        ActionsOf(span).Should().Equal("pairing_approved", "tv.key");

        ActionsOf(await GetJsonAsync(app, token, $"?{Window}&module=tv&outcome=failure&action=tv.text")).Should().Equal("tv.text");
        ActionsOf(await GetJsonAsync(app, token, $"?{Window}&module=devices&outcome=failure")).Should().BeEmpty();
    }

    [Fact]
    public async Task PersonFilter_FindsWhatTheAccountDid_AndWhatWasDoneToIt()
    {
        var (app, token, ownerId, guestId) = await SeededAsync();
        await using var lifetime = app;

        var page = await GetJsonAsync(app, token, $"?{Window}&person={guestId}");

        var items = Items(page);
        ActionsOf(page).Should().BeEquivalentTo("tv.text", "tv.key", "guest_revoked", "permissions_changed");
        items.Should().OnlyContain(i =>
            (i.GetProperty("actor").ValueKind == JsonValueKind.Object && i.GetProperty("actor").GetProperty("id").GetGuid() == guestId)
            || (i.GetProperty("targetAccount").ValueKind == JsonValueKind.Object && i.GetProperty("targetAccount").GetProperty("id").GetGuid() == guestId));

        var revoked = items.Single(i => i.GetProperty("action").GetString() == "guest_revoked");
        revoked.GetProperty("actor").GetProperty("id").GetGuid().Should().Be(ownerId);
        revoked.GetProperty("targetAccount").GetProperty("displayName").GetString().Should().Be("Alice");
        var changed = items.Single(i => i.GetProperty("action").GetString() == "permissions_changed");
        changed.GetProperty("detail").GetString().Should().Be("+tv:power|-");
    }

    [Fact]
    public async Task Names_AreTheCurrentOnes_AndAMissingAccountDoesNotBreakAnything()
    {
        var (app, token, ownerId, _) = await SeededAsync();
        await using var lifetime = app;
        var gone = Guid.NewGuid();
        await AddAsync(app.Database, Command(gone, "tv.wake", null, true, T0.AddMinutes(20)));

        await ExecuteAsync(app.Database.OwnerConnection, $"UPDATE identity.users SET display_name = 'Nome Novo' WHERE id = '{ownerId}'");

        var page = await GetJsonAsync(app, token, $"?{Window}&limit=200");

        var items = Items(page);
        var wake = items.Single(i => i.GetProperty("action").GetString() == "tv.wake");
        wake.GetProperty("actor").GetProperty("id").GetGuid().Should().Be(gone);
        wake.GetProperty("actor").GetProperty("displayName").ValueKind.Should().Be(JsonValueKind.Null);

        var unknownLogin = items.Single(i => i.GetProperty("action").GetString() == "login_failed");
        unknownLogin.GetProperty("actor").ValueKind.Should().Be(JsonValueKind.Null);

        items.Single(i => i.GetProperty("action").GetString() == "tv.key" && i.GetProperty("target").GetString() == "HOME")
            .GetProperty("actor").GetProperty("displayName").GetString().Should().Be("Nome Novo");
    }

    [Fact]
    public async Task Paging_WithManyRowsAtTheSameInstant_NeverRepeatsOrSkips()
    {
        var (app, owner, ownerId) = await StartAsync();
        await using var lifetime = app;
        var user = ownerId;

        // 12 linhas por fonte no MESMO instante (o pior caso do desempate), mais uma camada mais nova e uma mais velha.
        var tie = T0;
        var tv = Enumerable.Range(0, 12).Select(_ => Command(user, "tv.key", "HOME", true, tie)).ToList();
        var devices = Enumerable.Range(0, 12)
            .Select(_ => PairingAuditEntry.Create(PairingEvents.Started, null, Guid.NewGuid(), null, "198.51.100.9", "a", tie)).ToList();
        var identity = Enumerable.Range(0, 12)
            .Select(_ => LoginAuditEntry.Create(user, AuditEvents.RefreshSucceeded, tie, "198.51.100.1", "n", null)).ToList();
        var newer = Command(user, "tv.key", "NEWER", true, tie.AddSeconds(1));
        var older = Command(user, "tv.key", "OLDER", true, tie.AddSeconds(-1));
        await AddAsync(app.Database, [.. tv, newer, older]);
        await AddAsync(app.Database, [.. devices]);
        await AddAsync(app.Database, [.. identity]);

        static AuditRecord Shape(Guid id, string module, DateTimeOffset at) =>
            new(id, at, module, "x", null, null, null, AuditOutcome.Success, null, null, null);

        var expected = tv.Select(e => Shape(e.Id, "tv", e.OccurredAt))
            .Concat(devices.Select(e => Shape(e.Id, "devices", e.OccurredAt)))
            .Concat(identity.Select(e => Shape(e.Id, "identity", e.OccurredAt)))
            .Append(Shape(newer.Id, "tv", newer.OccurredAt))
            .Append(Shape(older.Id, "tv", older.OccurredAt))
            .OrderBy(r => r, AuditOrder.Newest)
            .Select(r => r.Id)
            .ToList();
        expected.Should().HaveCount(38);

        var seen = new List<Guid>();
        string? cursor = null;
        var pages = 0;
        do
        {
            var query = $"?{Window}&limit=7" + (cursor is null ? string.Empty : "&cursor=" + cursor);
            var page = await GetJsonAsync(app, owner.AccessToken, query);
            seen.AddRange(Items(page).Select(i => i.GetProperty("id").GetGuid()));
            cursor = page.GetProperty("nextCursor").GetString();
            pages++;
            pages.Should().BeLessThan(20, "a paginação precisa terminar");
        }
        while (cursor is not null);

        seen.Should().OnlyHaveUniqueItems("nenhuma linha se repete entre páginas");
        seen.Should().Equal(expected, "nenhuma linha some e a ordem é a total (instante, fonte, id)");
        pages.Should().Be(6, "38 linhas em páginas de 7");
    }

    [Fact]
    public async Task Paging_ThePageThatEndsExactlyOnTheLastRow_HasNoNextCursor()
    {
        var (app, token, _, _) = await SeededAsync();
        await using var lifetime = app;

        var all = await GetJsonAsync(app, token, $"?{Window}&limit=9");
        var more = await GetJsonAsync(app, token, $"?{Window}&limit=8");

        all.GetProperty("nextCursor").ValueKind.Should().Be(JsonValueKind.Null);
        more.GetProperty("nextCursor").ValueKind.Should().Be(JsonValueKind.String);
        var rest = await GetJsonAsync(app, token, $"?{Window}&limit=8&cursor={more.GetProperty("nextCursor").GetString()}");
        Items(rest).Should().ContainSingle();
        rest.GetProperty("nextCursor").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task BadParameters_Are400_WithProblemJson_AndNeverEchoTheValue()
    {
        var (app, token, _, _) = await SeededAsync();
        await using var lifetime = app;
        var foreignCursor = new AuditCursor(T0, "training", Guid.NewGuid()).Encode();

        foreach (var query in new[]
        {
            "?cursor=lixo",
            $"?cursor={foreignCursor}",
            "?limit=0",
            "?limit=201",
            "?from=ontem-talvez",
            "?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z",
            "?person=nao-e-guid",
            "?module=training",
            "?outcome=talvez",
            "?action=%3Cscript%3E",
        })
        {
            using var response = await GetAsync(app, token, query);
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest, query);
            response.Content.Headers.ContentType!.MediaType.Should().Be("application/problem+json", query);
            var text = await response.Content.ReadAsStringAsync(Ct);
            text.Should().NotContain("ontem-talvez").And.NotContain("script").And.NotContain("talvez").And.NotContain("lixo");
        }
    }

    [Fact]
    public async Task ACursorFromAValidSourceAndInstant_IsAccepted()
    {
        var (app, token, _, _) = await SeededAsync();
        await using var lifetime = app;
        var cursor = new AuditCursor(T0.AddMinutes(4), "tv", Guid.NewGuid()).Encode();

        var page = await GetJsonAsync(app, token, $"?{Window}&cursor={cursor}");

        ActionsOf(page).Should().NotContain(["login_locked", "login_failed"], "tudo que vem depois do cursor é mais velho que ele");
        Items(page).Should().NotBeEmpty();
    }

    [Fact]
    public async Task TypedEmailAndPassword_OfAFailedLogin_NeverAppearInTheTrail()
    {
        var (app, owner, _) = await StartAsync();
        await using var lifetime = app;
        const string typedEmail = "segredo-digitado@uniover.test";
        const string typedPassword = "senha-que-nao-existe-123";

        using var failed = await app.LoginRawAsync(typedEmail, typedPassword);
        failed.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        using var response = await GetAsync(app, owner.AccessToken, "?limit=200&action=login_failed");
        var body = await response.Content.ReadAsStringAsync(Ct);
        body.Should().Contain("login_failed", "a tentativa fica registrada");
        body.Should().NotContain("segredo-digitado").And.NotContain(typedPassword);
        var item = Items(JsonDocument.Parse(body).RootElement).Single();
        item.GetProperty("actor").ValueKind.Should().Be(JsonValueKind.Null, "e-mail desconhecido não aponta para conta nenhuma");
    }

    [Fact]
    public async Task Export_IsACsvOfTheSameFilter_DefusesFormulas_AndIsItselfAudited()
    {
        var (app, token, ownerId, _) = await SeededAsync();
        await using var lifetime = app;
        await AddAsync(app.Database, Command(ownerId, "tv.key", "MENU", true, T0.AddMinutes(10), ip: "203.0.113.77", agent: "=HYPERLINK(\"http://x\",\"c\")"));

        using var response = await GetAsync(app, token, $"?{Window}&module=tv", "/export");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.ToString().Should().Be("text/csv; charset=utf-8");
        response.Content.Headers.ContentDisposition!.DispositionType.Should().Be("attachment");
        response.Content.Headers.ContentDisposition.FileName.Should().MatchRegex(@"^auditoria-\d{8}-\d{4}\.csv$");
        response.Headers.Contains("X-Audit-Truncated").Should().BeFalse();

        var bytes = await response.Content.ReadAsByteArrayAsync(Ct);
        bytes[..3].Should().Equal(0xEF, 0xBB, 0xBF);
        var lines = Encoding.UTF8.GetString(bytes[3..]).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        lines[0].Should().StartWith("occurredAt,module,action,outcome");
        lines.Length.Should().Be(1 + 4, "só as 4 linhas de comando da TV na janela");
        lines.Should().Contain(l => l.Contains("203.0.113.77", StringComparison.Ordinal) && l.EndsWith("'=HYPERLINK(\"\"http://x\"\",\"\"c\"\")\"", StringComparison.Ordinal),
            "a fórmula no aparelho vira texto");
        string.Join('\n', lines).Should().NotContain(app.OwnerEmail);

        await using var db = app.Db();
        var export = await db.LoginAudit.AsNoTracking().SingleAsync(a => a.Event == AuditEvents.AuditExported, Ct);
        export.UserId.Should().Be(ownerId);
        export.Detail.Should().Be("rows=4");
    }

    [Fact]
    public async Task Export_BeyondTheCap_KeepsTheNewestRows_AndSaysItWasCut()
    {
        var (app, owner, ownerId) = await StartAsync();
        await using var lifetime = app;
        await ExecuteAsync(app.Database.OwnerConnection,
            "INSERT INTO tv.command_audit (id, user_id, command, ok, detail, occurred_at) " +
            $"SELECT gen_random_uuid(), '{ownerId}', 'tv.key', true, 'k' || g, '2026-10-01T12:00:00Z'::timestamptz + (g * interval '1 second') " +
            "FROM generate_series(1, 5001) g");

        using var response = await GetAsync(app, owner.AccessToken, $"?{Window}", "/export");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.GetValues("X-Audit-Truncated").Should().Equal("true");
        var text = Encoding.UTF8.GetString((await response.Content.ReadAsByteArrayAsync(Ct))[3..]);
        var lines = text.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        lines.Length.Should().Be(1 + 5000);
        text.Should().Contain(",k5001,", "a linha mais nova entra").And.NotContain(",k1,", "a mais velha é a cortada");
    }

    [Fact]
    public async Task RealFlows_LeaveRowsTheAdministratorCanRead()
    {
        var (app, owner, ownerId) = await StartAsync();
        await using var lifetime = app;

        using var refresh = await app.RefreshRawAsync(owner.RefreshSecret);
        refresh.StatusCode.Should().Be(HttpStatusCode.OK);

        var page = await GetJsonAsync(app, owner.AccessToken, "?limit=200&module=identity");

        var actions = ActionsOf(page);
        actions.Should().Contain([AuditEvents.OwnerCreated, AuditEvents.LoginSucceeded, AuditEvents.RefreshSucceeded]);
        Items(page).Where(i => i.GetProperty("action").GetString() == AuditEvents.LoginSucceeded)
            .Should().OnlyContain(i => i.GetProperty("actor").GetProperty("id").GetGuid() == ownerId);
    }
}
