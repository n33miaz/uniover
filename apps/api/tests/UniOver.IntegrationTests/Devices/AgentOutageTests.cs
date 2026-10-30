using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.Outages;
using UniOver.Modules.Devices.Ports;
using UniOver.Modules.Identity.Domain;
using UniOver.SharedKernel;

namespace UniOver.IntegrationTests.Devices;

/// <summary>
/// O monitor de presença: um aviso por queda (a mesma queda nunca abre duas vezes), a volta fecha a queda e o limite vem
/// do ajuste do dono. Tudo com Host real, Postgres real e relógio falso; o monitor é chamado direto (o laço do serviço só
/// o repete a cada minuto).
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class AgentOutageTests(PostgresFixture postgres)
{
    private const string Alerts = "/api/v1/devices/agent-alerts";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<Guid> AddAgentAsync(DevicesApp app, string slug, string name, DateTimeOffset? lastSeen)
    {
        await using var db = app.Db();
        var agent = Agent.Create(IdGenerator.NewId(), slug, name, "windows", Guid.NewGuid(), app.Time.GetUtcNow());
        db.Agents.Add(agent);
        if (lastSeen is { } seen)
        {
            var snapshot = AgentPresenceSnapshot.Create(agent.Id);
            snapshot.RecordLastSeen(seen);
            db.AgentPresenceSnapshots.Add(snapshot);
        }

        await db.SaveChangesAsync(Ct);
        return agent.Id;
    }

    private static async Task CheckAsync(DevicesApp app)
    {
        await using var scope = app.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<AgentOutageMonitor>().CheckAsync(Ct);
    }

    private static async Task<int> AuditCountAsync(DevicesApp app, string eventName)
    {
        await using var db = app.Db();
        return await db.PairingAudit.CountAsync(a => a.Event == eventName, Ct);
    }

    private static async Task SetLimitAsync(DevicesApp app, int minutes)
    {
        await using var db = IdentityApp.CreateContext(app.Database.OwnerConnection);
        db.SystemSettings.Add(new SystemSetting
        {
            Key = "devices.agent-offline-minutes",
            ValueJson = minutes.ToString(System.Globalization.CultureInfo.InvariantCulture),
            UpdatedBy = Guid.NewGuid(),
            UpdatedAt = app.Time.GetUtcNow(),
        });
        await db.SaveChangesAsync(Ct);
    }

    [Fact]
    public async Task ASilentAgentOpensOneOutagePerDrop_AndTheAuditSaysSo()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var agentId = await AddAgentAsync(app, "pc-sala", "PC da sala", app.Time.GetUtcNow());
        await CheckAsync(app);

        app.Time.Advance(TimeSpan.FromMinutes(9));
        await CheckAsync(app);
        await using (var early = app.Db())
        {
            (await early.AgentOutages.CountAsync(Ct)).Should().Be(0, "ainda dentro dos 10 minutos padrão");
        }

        app.Time.Advance(TimeSpan.FromMinutes(2));
        await CheckAsync(app);
        await CheckAsync(app);
        app.Time.Advance(TimeSpan.FromMinutes(5));
        await CheckAsync(app);

        await using var db = app.Db();
        var outage = await db.AgentOutages.SingleAsync(Ct);
        outage.AgentId.Should().Be(agentId);
        outage.RecoveredAt.Should().BeNull();
        outage.SeenAt.Should().BeNull();
        (await AuditCountAsync(app, PairingEvents.AgentOffline)).Should().Be(1, "um aviso por queda, mesmo com vários ciclos");
        await using var audit = app.Db();
        var row = await audit.PairingAudit.SingleAsync(a => a.Event == PairingEvents.AgentOffline, Ct);
        row.AgentId.Should().Be(agentId);
        row.UserId.Should().BeNull("é o sistema que registra");
        row.Ip.Should().BeNull();
    }

    [Fact]
    public async Task ConnectedAgentNeverCountsAsDown_AndTheReturnClosesTheOutage()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var presence = app.Services.GetRequiredService<IPresenceStore>();
        await AddAgentAsync(app, "pc-sala", "PC da sala", app.Time.GetUtcNow());
        await CheckAsync(app);

        // Conectado há muito tempo com o retrato velho: não está caído.
        presence.MarkConnected("pc-sala", app.Time.GetUtcNow());
        app.Time.Advance(TimeSpan.FromMinutes(30));
        await CheckAsync(app);
        await using (var connected = app.Db())
        {
            (await connected.AgentOutages.CountAsync(Ct)).Should().Be(0);
        }

        presence.MarkDisconnected("pc-sala", app.Time.GetUtcNow());
        app.Time.Advance(TimeSpan.FromMinutes(11));
        await CheckAsync(app);
        (await AuditCountAsync(app, PairingEvents.AgentOffline)).Should().Be(1);

        // A volta fecha a mesma queda e registra a volta.
        presence.MarkConnected("pc-sala", app.Time.GetUtcNow());
        await CheckAsync(app);
        await CheckAsync(app);
        await using (var back = app.Db())
        {
            var outage = await back.AgentOutages.SingleAsync(Ct);
            outage.RecoveredAt.Should().NotBeNull();
        }

        (await AuditCountAsync(app, PairingEvents.AgentOnline)).Should().Be(1);

        // Outra queda depois é outro aviso.
        presence.MarkDisconnected("pc-sala", app.Time.GetUtcNow());
        app.Time.Advance(TimeSpan.FromMinutes(11));
        await CheckAsync(app);
        await using var again = app.Db();
        (await again.AgentOutages.CountAsync(Ct)).Should().Be(2);
        (await again.AgentOutages.CountAsync(o => o.RecoveredAt == null, Ct)).Should().Be(1);
        (await AuditCountAsync(app, PairingEvents.AgentOffline)).Should().Be(2);
    }

    [Fact]
    public async Task RightAfterTheServiceStarts_AStaleSnapshotIsNotAnOutage()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        // O retrato é de uma hora atrás (a API dormia ou foi publicada): o computador ainda está reconectando.
        await AddAgentAsync(app, "pc-sala", "PC da sala", app.Time.GetUtcNow().AddHours(-1));

        await CheckAsync(app);
        app.Time.Advance(TimeSpan.FromMinutes(5));
        await CheckAsync(app);
        await using (var grace = app.Db())
        {
            (await grace.AgentOutages.CountAsync(Ct)).Should().Be(0);
        }

        // Passado o limite desde a partida sem o agente falar, aí sim caiu.
        app.Time.Advance(TimeSpan.FromMinutes(6));
        await CheckAsync(app);
        await using var db = app.Db();
        (await db.AgentOutages.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task AnAgentThatNeverSpokeIsNotAnOutage()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        await AddAgentAsync(app, "pc-novo", "PC novo", lastSeen: null);
        await CheckAsync(app);
        app.Time.Advance(TimeSpan.FromHours(3));
        await CheckAsync(app);
        await using var db = app.Db();
        (await db.AgentOutages.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task TheLimitComesFromTheOwnersSetting()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        await SetLimitAsync(app, 3);
        await AddAgentAsync(app, "pc-sala", "PC da sala", app.Time.GetUtcNow());
        await CheckAsync(app);

        app.Time.Advance(TimeSpan.FromMinutes(2));
        await CheckAsync(app);
        await using (var early = app.Db())
        {
            (await early.AgentOutages.CountAsync(Ct)).Should().Be(0);
        }

        app.Time.Advance(TimeSpan.FromMinutes(2));
        await CheckAsync(app);
        await using var db = app.Db();
        (await db.AgentOutages.CountAsync(Ct)).Should().Be(1, "4 minutos sem sinal passam do limite de 3");
    }

    [Fact]
    public async Task RevokingTheAgentEndsItsOutage_WithoutABackNotice()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var agentId = await AddAgentAsync(app, "pc-sala", "PC da sala", app.Time.GetUtcNow());
        await CheckAsync(app);
        app.Time.Advance(TimeSpan.FromMinutes(11));
        await CheckAsync(app);

        await using (var revoke = app.Db())
        {
            var agent = await revoke.Agents.SingleAsync(a => a.Id == agentId, Ct);
            agent.Revoke(app.Time.GetUtcNow(), Guid.NewGuid(), null);
            await revoke.SaveChangesAsync(Ct);
        }

        await CheckAsync(app);
        await using var db = app.Db();
        (await db.AgentOutages.SingleAsync(Ct)).RecoveredAt.Should().NotBeNull();
        (await AuditCountAsync(app, PairingEvents.AgentOnline)).Should().Be(0);
    }

    [Fact]
    public async Task OnlyTheOwnerReadsTheAlerts_AndSeeingThemClearsTheList()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        await AddAgentAsync(app, "pc-sala", "PC da sala", app.Time.GetUtcNow());
        await CheckAsync(app);
        app.Time.Advance(TimeSpan.FromMinutes(11));
        await CheckAsync(app);

        // O token vale 10 minutos no relógio falso: as contas entram depois do avanço.
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var anonymous = await app.SendAsync(HttpMethod.Get, Alerts);
        using var asGuest = await app.SendAsync(HttpMethod.Get, Alerts, bearer: guest.Login.AccessToken);
        using var guestSeen = await app.SendAsync(HttpMethod.Post, Alerts + "/seen", bearer: guest.Login.AccessToken);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        guestSeen.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        using var list = await app.SendAsync(HttpMethod.Get, Alerts, bearer: owner.AccessToken);
        list.StatusCode.Should().Be(HttpStatusCode.OK);
        var items = (await list.Content.ReadFromJsonAsync<JsonElement>(Ct)).EnumerateArray().ToList();
        items.Should().ContainSingle();
        items[0].GetProperty("agentName").GetString().Should().Be("PC da sala");
        items[0].GetProperty("recoveredAt").ValueKind.Should().Be(JsonValueKind.Null);

        var alertId = items[0].GetProperty("id").GetString();
        using var oneAnonymous = await app.SendAsync(HttpMethod.Post, $"{Alerts}/{alertId}/seen");
        using var oneAsGuest = await app.SendAsync(HttpMethod.Post, $"{Alerts}/{alertId}/seen", bearer: guest.Login.AccessToken);
        using var badId = await app.SendAsync(HttpMethod.Post, $"{Alerts}/nao-e-um-id/seen", bearer: owner.AccessToken);
        oneAnonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        oneAsGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        badId.StatusCode.Should().Be(HttpStatusCode.NotFound);
        using var stillThere = await app.SendAsync(HttpMethod.Get, Alerts, bearer: owner.AccessToken);
        (await stillThere.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetArrayLength().Should().Be(1, "as recusas não limpam o alerta");

        using var oneSeen = await app.SendAsync(HttpMethod.Post, $"{Alerts}/{alertId}/seen", bearer: owner.AccessToken);
        oneSeen.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var afterOne = await app.SendAsync(HttpMethod.Get, Alerts, bearer: owner.AccessToken);
        (await afterOne.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetArrayLength().Should().Be(0);

        using var seen = await app.SendAsync(HttpMethod.Post, Alerts + "/seen", bearer: owner.AccessToken);
        seen.StatusCode.Should().Be(HttpStatusCode.NoContent);
        using var after = await app.SendAsync(HttpMethod.Get, Alerts, bearer: owner.AccessToken);
        (await after.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task ARecoveredOutageStaysListedUntilSeenOrADayPasses()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var presence = app.Services.GetRequiredService<IPresenceStore>();
        await AddAgentAsync(app, "pc-sala", "PC da sala", app.Time.GetUtcNow());
        await CheckAsync(app);
        app.Time.Advance(TimeSpan.FromMinutes(11));
        await CheckAsync(app);
        presence.MarkConnected("pc-sala", app.Time.GetUtcNow());
        await CheckAsync(app);
        var owner = await app.LoginAsync();

        using var back = await app.SendAsync(HttpMethod.Get, Alerts, bearer: owner.AccessToken);
        var item = (await back.Content.ReadFromJsonAsync<JsonElement>(Ct)).EnumerateArray().Single();
        item.GetProperty("recoveredAt").ValueKind.Should().Be(JsonValueKind.String);

        app.Time.Advance(TimeSpan.FromHours(25));
        var later = await app.LoginAsync();
        using var late = await app.SendAsync(HttpMethod.Get, Alerts, bearer: later.AccessToken);
        (await late.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task TheAdminTrailShowsTheDropAndTheReturn()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var presence = app.Services.GetRequiredService<IPresenceStore>();
        await AddAgentAsync(app, "pc-sala", "PC da sala", app.Time.GetUtcNow());
        await CheckAsync(app);
        app.Time.Advance(TimeSpan.FromMinutes(11));
        await CheckAsync(app);
        presence.MarkConnected("pc-sala", app.Time.GetUtcNow());
        await CheckAsync(app);
        var owner = await app.LoginAsync();

        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/audit?module=devices", bearer: owner.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var actions = (await response.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("action").GetString()).ToList();
        actions.Should().Contain(["agent_offline", "agent_online"]);
    }
}
