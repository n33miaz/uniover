using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Domain;
using UniOver.SharedKernel;

namespace UniOver.IntegrationTests.Devices.Diagnostics;

/// <summary>
/// O aviso "Falha de Atualização" do dono: nasce das ocorrências <c>update.*</c> de severidade <c>error</c> que o agente conta
/// (pelo canal real ou já gravadas), sai uma vez por computador enquanto não visto e some quando o dono o dispensa. Host real,
/// Postgres real e relógio falso.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class AgentUpdateAlertTests(PostgresFixture postgres)
{
    private const string Alerts = "/api/v1/devices/agent-alerts";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task SeedAsync(TransportApp app, string kind, string severity, string detail, TimeSpan ago)
    {
        var now = app.App.Time.GetUtcNow();
        await using var db = app.App.Db();
        db.AgentDiagnosticEvents.Add(AgentDiagnosticEvent.Create(
            IdGenerator.NewId(), app.Agent.Id, Guid.NewGuid(), now - ago, now, kind, severity, "update", detail, 1));
        await db.SaveChangesAsync(Ct);
    }

    private static async Task<List<JsonElement>> ListAsync(TransportApp app)
    {
        var owner = await app.App.LoginAsync();
        using var response = await app.App.SendAsync(HttpMethod.Get, Alerts, bearer: owner.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await response.Content.ReadFromJsonAsync<JsonElement>(Ct)).EnumerateArray().ToList();
    }

    [Fact]
    public async Task AnErrorFromTheAgentOverTheChannelBecomesOneUpdateFailureAlert()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();
        var now = app.App.Time.GetUtcNow();
        var batch = new JsonObject
        {
            ["events"] = new JsonArray
            {
                new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString(),
                    ["at"] = now.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture),
                    ["kind"] = "update.failed",
                    ["severity"] = "error",
                    ["component"] = "update",
                    ["detail"] = "não atualizei agora: sem rede",
                },
            },
        };

        await agent.SendTextAsync(agent.Envelope("agent.diagnostics.v1", batch));
        await TransportApp.WaitUntilAsync(async () => (await ListAsync(app)).Count == 1, "o aviso de falha de atualização");

        var alert = (await ListAsync(app)).Single();
        alert.GetProperty("kind").GetString().Should().Be("update_failed");
        alert.GetProperty("agentName").GetString().Should().Be("PC Casa");
        alert.GetProperty("agentId").GetGuid().Should().Be(app.Agent.Id);
        alert.GetProperty("detail").GetString().Should().Be("não atualizei agora: sem rede");
        alert.GetProperty("recoveredAt").ValueKind.Should().Be(JsonValueKind.Null);
        alert.GetProperty("detectedAt").GetDateTimeOffset().Should().BeCloseTo(now, TimeSpan.FromSeconds(2));
    }

    [Theory]
    [InlineData("update.failed")]
    [InlineData("update.rejected")]
    [InlineData("update.sync_failed")]
    [InlineData("update.rollback_failed")]
    [InlineData("update.rolled_back")]
    public async Task EveryUpdateErrorKindRaisesTheAlert(string kind)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await SeedAsync(app, kind, "error", "falhou", TimeSpan.FromMinutes(1));

        (await ListAsync(app)).Should().ContainSingle().Which.GetProperty("kind").GetString().Should().Be("update_failed");
    }

    [Fact]
    public async Task RoutineAndOwnerRequestedOccurrencesNeverRaiseIt()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await SeedAsync(app, "update.installed", "info", "versão nova instalada", TimeSpan.FromMinutes(5));
        await SeedAsync(app, "update.confirmed", "info", "se confirmou", TimeSpan.FromMinutes(4));
        // A volta que o próprio dono pediu chega como aviso comum, não como erro.
        await SeedAsync(app, "update.rolled_back", "warn", "voltei a pedido do administrador", TimeSpan.FromMinutes(3));
        // Erro de outro assunto não é falha de atualização.
        await SeedAsync(app, "background.failed", "error", "TimeoutError em session.py:watch", TimeSpan.FromMinutes(2));
        await SeedAsync(app, "process.exited", "error", "o agente terminou sozinho", TimeSpan.FromMinutes(1));

        (await ListAsync(app)).Should().BeEmpty();
    }

    [Fact]
    public async Task SeveralFailuresInARowAreOneAlert_WithTheNewestDetail()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await SeedAsync(app, "update.failed", "error", "primeira tentativa", TimeSpan.FromHours(3));
        await SeedAsync(app, "update.failed", "error", "segunda tentativa", TimeSpan.FromHours(2));
        await SeedAsync(app, "update.sync_failed", "error", "terceira, no ambiente", TimeSpan.FromHours(1));

        var alert = (await ListAsync(app)).Should().ContainSingle().Subject;
        alert.GetProperty("detail").GetString().Should().Be("terceira, no ambiente");
    }

    [Fact]
    public async Task DismissingTheAlertClearsTheEarlierOnes_AndANewFailureRaisesItAgain()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await SeedAsync(app, "update.failed", "error", "antes", TimeSpan.FromHours(2));
        await SeedAsync(app, "update.failed", "error", "agora", TimeSpan.FromHours(1));
        var owner = await app.App.LoginAsync();

        var id = (await ListAsync(app)).Single().GetProperty("id").GetString();
        using var seen = await app.App.SendAsync(HttpMethod.Post, $"{Alerts}/{id}/seen", bearer: owner.AccessToken);
        seen.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await ListAsync(app)).Should().BeEmpty("as falhas anteriores do mesmo computador saem junto");

        await SeedAsync(app, "update.failed", "error", "de novo", TimeSpan.FromMinutes(1));
        var again = (await ListAsync(app)).Should().ContainSingle().Subject;
        again.GetProperty("detail").GetString().Should().Be("de novo");
    }

    [Fact]
    public async Task SeeingEverythingClearsTheUpdateFailuresToo()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await SeedAsync(app, "update.rejected", "error", "pacote recusado", TimeSpan.FromMinutes(1));
        var owner = await app.App.LoginAsync();
        (await ListAsync(app)).Should().ContainSingle();

        using var seen = await app.App.SendAsync(HttpMethod.Post, Alerts + "/seen", bearer: owner.AccessToken);

        seen.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await ListAsync(app)).Should().BeEmpty();
    }

    [Fact]
    public async Task OnlyTheOwnerSeesTheUpdateFailures_AndARevokedComputerHasNone()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await SeedAsync(app, "update.failed", "error", "falhou", TimeSpan.FromMinutes(1));

        using var anonymous = await app.App.SendAsync(HttpMethod.Get, Alerts);
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        await using (var db = app.App.Db())
        {
            var agent = await db.Agents.FindAsync([app.Agent.Id], Ct);
            agent!.Revoke(app.App.Time.GetUtcNow(), Guid.NewGuid(), null);
            await db.SaveChangesAsync(Ct);
        }

        (await ListAsync(app)).Should().BeEmpty();
    }

    [Fact]
    public async Task AFailureOlderThanTheRetentionIsNotListed()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await SeedAsync(app, "update.failed", "error", "antiga", TimeSpan.FromHours(1));

        app.App.Time.Advance(TimeSpan.FromDays(8));

        (await ListAsync(app)).Should().BeEmpty();
    }
}
