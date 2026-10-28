using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Npgsql;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.IntegrationTests.Devices.Pairing;

[Collection(PostgresGroup.Name)]
public sealed class AuditAndSafetyTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DevicesAppOptions NoStepUp = new() { RequireStepUp = false };

    [Fact]
    public async Task Audit_RecordsEveryStep_WithWhoFromWhereAndWhichDevice_AndNeverASecret()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { RequireStepUp = false, ForwardedHeaders = true });
        var login = await app.LoginAsync();

        var started = await app.StartAsync(forwardedFor: "203.0.113.7", userAgent: "agente-teste/1.0");
        using var approve = await app.ApproveRawAsync(login, started.UserCode, forwardedFor: "198.51.100.9");
        var agentId = (await DevicesApp.JsonAsync(approve)).GetProperty("id").GetGuid();
        using var poll = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        var token = (await DevicesApp.JsonAsync(poll)).GetProperty("deviceToken").GetString()!;
        (await app.RevokeRawAsync(login, agentId, forwardedFor: "198.51.100.9")).Dispose();
        var denied = await app.StartAsync("Outro");
        (await app.DenyRawAsync(login, denied.UserCode)).Dispose();

        await using var db = app.Db();
        var rows = await db.PairingAudit.OrderBy(a => a.OccurredAt).ThenBy(a => a.Id).ToListAsync(Ct);
        rows.Select(a => a.Event).Should().BeEquivalentTo(
            ["pairing_started", "approved", "token_issued", "agent_revoked", "pairing_started", "denied"]);

        var begin = rows.First(a => a.Event == "pairing_started");
        begin.Ip.Should().Be("203.0.113.7");
        begin.UserAgent.Should().Be("agente-teste/1.0");
        begin.PairingId.Should().Be(started.PairingId);
        begin.UserId.Should().BeNull();

        var approved = rows.Single(a => a.Event == "approved");
        approved.AgentId.Should().Be(agentId);
        approved.UserId.Should().NotBeNull();
        approved.Ip.Should().Be("198.51.100.9");

        rows.Single(a => a.Event == "token_issued").AgentId.Should().Be(agentId);
        var revoked = rows.Single(a => a.Event == "agent_revoked");
        revoked.UserId.Should().Be(approved.UserId);
        rows.Single(a => a.Event == "denied").UserId.Should().Be(approved.UserId);
        rows.Should().OnlyContain(a => a.OccurredAt == app.Time.GetUtcNow());

        var dump = JsonSerializer.Serialize(rows.Select(a => new { a.Event, a.Ip, a.UserAgent, a.AgentId, a.PairingId, a.UserId }));
        dump.Should().NotContain(started.DeviceCode).And.NotContain(token).And.NotContain("uo_dev_");
    }

    [Fact]
    public async Task NoLogLine_CarriesTheDeviceCode_TheTokenOrTheUserCode()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();

        // Todos os caminhos que mexem em segredo: início, consulta pendente, rápida e errada, aprovação, token, repetição, revogação.
        var started = await app.StartAsync();
        (await app.PollRawAsync(started.PairingId, started.DeviceCode)).Dispose();
        (await app.PollRawAsync(started.PairingId, started.DeviceCode)).Dispose();
        (await app.PollRawAsync(started.PairingId, "errado-" + started.DeviceCode)).Dispose();
        var agent = await app.ApproveAsync(login, started.UserCode);
        using var poll = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        var token = (await DevicesApp.JsonAsync(poll)).GetProperty("deviceToken").GetString()!;
        (await app.PollRawAsync(started.PairingId, started.DeviceCode)).Dispose();
        (await app.ValidateAsync(token)).IsValid.Should().BeTrue();
        (await app.RevokeRawAsync(login, agent.GetProperty("id").GetGuid())).Dispose();
        await app.WaitForOutboxAsync(2);

        var lines = app.Logs.Lines;
        lines.Should().NotBeEmpty();
        var secrets = new[]
        {
            started.DeviceCode, token, token[7..], started.UserCode, started.UserCode.Replace("-", string.Empty, StringComparison.Ordinal),
        };
        foreach (var secret in secrets)
        {
            lines.Should().NotContain(l => l.Contains(secret, StringComparison.Ordinal), "segredo de pareamento nenhum pode ir para o log");
        }
    }

    [Fact]
    public async Task PollingTooOften_Returns429WithRetryAfter()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { RequireStepUp = false, PairingPermitted = 4 });
        var started = await app.StartAsync();

        HttpResponseMessage? last = null;
        for (var i = 0; i < 6 && last?.StatusCode != HttpStatusCode.TooManyRequests; i++)
        {
            last?.Dispose();
            last = await app.PollRawAsync(started.PairingId, started.DeviceCode);
        }

        using (last)
        {
            last!.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
            last.Headers.RetryAfter.Should().NotBeNull();
            (await DevicesApp.JsonAsync(last)).GetProperty("type").GetString().Should().EndWith("/rate-limited");
        }
    }

    [Fact]
    public async Task EveryPairingRoute_SharesThePairingRateLimit_IncludingTheAuthenticatedOnes()
    {
        await using var app = await DevicesApp.StartAsync(postgres, new DevicesAppOptions { RequireStepUp = false, PairingPermitted = 2 });
        var login = await app.LoginAsync();

        // Duas chamadas gastam a cota do IP; a terceira, em rota autenticada, já é recusada pelo limite.
        (await app.StartAsync()).PairingId.Should().NotBeEmpty();
        (await app.DenyRawAsync(login, "BCDF-GHJK")).Dispose();
        using var third = await app.DenyRawAsync(login, "BCDF-GHJK");

        third.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task OnlyInfoStartAndPoll_AreAnonymousInTheDevicesModule()
    {
        await using var factory = await GuardHost.StartAsync(postgres, "Production");
        var routes = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(r => RouteInspector.Module(RouteInspector.Pattern(r)) == "devices")
            .ToList();

        routes.Should().NotBeEmpty();
        var anonymous = routes.Where(r => RouteInspector.Classify(r) == RouteKind.Public)
            .Select(RouteInspector.Describe).Order(StringComparer.Ordinal).ToList();
        anonymous.Should().Equal(
            "GET /api/v1/devices/info", "POST /api/v1/devices/pairing/poll", "POST /api/v1/devices/pairing/start");

        var approve = routes.Single(r => RouteInspector.Pattern(r) == "/api/v1/devices/pairing/approve");
        RouteInspector.Classify(approve).Should().Be(RouteKind.StepUp);
        routes.Where(r => RouteInspector.Pattern(r).Contains("/pairing/", StringComparison.Ordinal))
            .Should().OnlyContain(r => RouteInspector.RateLimitPolicy(r) == "pairing");
        RouteInspector.Violations(routes).Should().BeEmpty();
    }

    [Fact]
    public async Task Info_IsPublic_AndReportsTheModule()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);

        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/devices/info");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await DevicesApp.JsonAsync(response);
        body.GetProperty("module").GetString().Should().Be("devices");
        body.GetProperty("version").GetString().Should().Be("0.1.0");
    }

    [Fact]
    public void TheVersionedAppsettings_RequireTheStepUpAndKeepTheApprovedDefaults()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "UniOver.slnx")))
        {
            dir = dir.Parent;
        }

        dir.Should().NotBeNull();
        using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir!.FullName, "src", "UniOver.Host", "appsettings.json")));
        var pairing = json.RootElement.GetProperty("Modules").GetProperty("Devices").GetProperty("Pairing");

        pairing.GetProperty("RequireStepUp").GetBoolean().Should().BeTrue("em produção a aprovação exige a passkey");
        pairing.GetProperty("ExpiresMinutes").GetInt32().Should().Be(10);
        pairing.GetProperty("MinPollIntervalSeconds").GetInt32().Should().Be(5);
        pairing.GetProperty("MaxActive").GetInt32().Should().Be(5);

        // E o padrão do próprio tipo de opções também é o seguro (valor ausente na configuração não afrouxa nada).
        new PairingOptions().RequireStepUp.Should().BeTrue();
    }

    [Fact]
    public async Task TheStartedHost_WithoutOverrides_RequiresTheStepUp()
    {
        await using var factory = await GuardHost.StartAsync(postgres, "Production");

        factory.Services.GetRequiredService<IOptions<DevicesModuleOptions>>().Value.Pairing.RequireStepUp.Should().BeTrue();
    }

    [Fact]
    public async Task TheDevicesBundleMigrations_ApplyOnAnEmptyPostgres_WithTheRuntimeRoleLimitedToDml()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using (var context = DevicesApp.CreateContext(database.OwnerConnection))
        {
            await context.Database.MigrateAsync(Ct);
        }

        var tables = await Tables(database.OwnerConnection);
        tables.Should().Equal(
            "__ef_migrations_history", "agent_outages", "agent_presence_snapshots", "agents", "dead_letters", "idempotency_keys", "outbox_messages",
            "pairing_audit", "pairings");

        await using var runtime = new NpgsqlConnection(database.RuntimeConnection);
        await runtime.OpenAsync(Ct);
        await using (var dml = new NpgsqlCommand("SELECT count(*) FROM devices.agents", runtime))
        {
            (await dml.ExecuteScalarAsync(Ct)).Should().Be(0L);
        }

        await using var ddl = new NpgsqlCommand("CREATE TABLE devices.intruso (id int)", runtime);
        await ddl.Invoking(c => c.ExecuteNonQueryAsync(Ct)).Should().ThrowAsync<PostgresException>();
        await using var history = new NpgsqlCommand("SELECT count(*) FROM devices.__ef_migrations_history", runtime);
        await history.Invoking(c => c.ExecuteScalarAsync(Ct)).Should().ThrowAsync<PostgresException>();
        NpgsqlConnection.ClearAllPools();
    }

    private static async Task<List<string>> Tables(string connection)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'devices' ORDER BY table_name", conn);
        await using var reader = await command.ExecuteReaderAsync(Ct);
        var names = new List<string>();
        while (await reader.ReadAsync(Ct))
        {
            names.Add(reader.GetString(0));
        }

        return names;
    }
}
