using System.Net;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using UniOver.Modules.Tv.Domain;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// Remover uma TV promete apagar os dados dela. As tabelas de dados não têm FK para a TV (<c>tv_id = Guid.Empty</c> é a
/// instalação antiga, sem linha de TV), então uma mensagem do agente (ou uma requisição) que já resolveu a TV e só grava
/// depois da remoção deixaria linhas órfãs. Aqui a gravação é segurada no meio por um gatilho do Postgres, nas duas ordens
/// (a remoção chega no meio da gravação e a mensagem chega no meio da remoção).
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TvRemovalInFlightTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string DroppedLog = "descartada sem gravar";

    private static readonly object LayoutBody = new
    {
        name = "Sala", buttonSize = "large", showMedia = true, showChannel = false,
        startPage = "last", padSpeed = "normal", pillLayout = "row",
        extraKeys = new[] { "INPUT" }, dismissedSuggestions = Array.Empty<string>(),
    };

    private sealed record Setup(
        TvApp App, VirtualAuthenticator Authenticator, Guid TvId, FakeAgent Connection, Guid OtherTvId, FakeAgent OtherConnection)
        : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await OtherConnection.DisposeAsync();
            await Connection.DisposeAsync();
            Authenticator.Dispose();
            await App.DisposeAsync();
        }
    }

    /// <summary>Uma TV que será removida e outra que fica, cada uma com o computador conectado e anunciado.</summary>
    private async Task<Setup> StartAsync()
    {
        var app = await TvApp.StartAsync(postgres);
        var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, "tv.bind-agent");
        using (var bound = await app.SendAsync(HttpMethod.Put, "/api/v1/tv/config/agent", new { agentSlug = app.Agent.Slug }))
        {
            bound.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var (connection, tvId) = await AddTvAsync(app, "PC para remover", "TV para remover");
        var (otherConnection, otherTvId) = await AddTvAsync(app, "PC para manter", "TV para manter");
        return new Setup(app, authenticator, tvId, connection, otherTvId, otherConnection);
    }

    private static async Task<(FakeAgent Connection, Guid TvId)> AddTvAsync(TvApp app, string pcName, string tvName)
    {
        var agent = await app.PairAsync(pcName);
        var connection = await app.ConnectAsync(agent);
        await connection.SendHelloAsync("2.0.0", "tv.remote");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(agent.Slug)?.Connected == true, "agente conectado");
        using var response = await app.PostAsync("/api/v1/tv/tvs", new { agentSlug = agent.Slug, name = tvName });
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return (connection, (await TvApp.JsonAsync(response)).GetProperty("id").GetGuid());
    }

    /// <summary>Segura por 2 s o comando que o gatilho vigia, e só ele (a função é de uma instrução, não de linha).</summary>
    private static Task HoldAsync(TvApp app, string timing, string table) => app.ExecuteSqlAsync($$"""
        CREATE FUNCTION tv.hold_statement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(2); RETURN NULL; END $$;
        CREATE TRIGGER hold_statement {{timing}} ON {{table}}
            FOR EACH STATEMENT EXECUTE FUNCTION tv.hold_statement();
        """);

    private static Task SendAsync(FakeAgent agent, string kind) => kind switch
    {
        "apps" => agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.exemplo.um", "Um"), ("com.exemplo.dois", "Dois")))),
        "cleanup" => SendCleanupAsync(agent),
        _ => agent.SendTextAsync(agent.Envelope("tv.livre.state.v1", LivreState())),
    };

    private static Task SendCleanupAsync(FakeAgent agent)
    {
        var requestId = Guid.NewGuid();
        return agent.SendTextAsync(agent.Envelope("tv.cleanup.result.v1", AutomaticCleanup(requestId), requestId));
    }

    private static JsonObject AutomaticCleanup(Guid requestId) => new()
    {
        ["requestId"] = requestId.ToString(),
        ["closedApps"] = 2,
        ["closedPackages"] = new JsonArray("com.exemplo.a", "com.exemplo.b"),
        ["memoryBeforeMb"] = 300,
        ["memoryAfterMb"] = 500,
        ["freedMb"] = 200,
        ["failedSteps"] = new JsonArray(),
        ["at"] = "2026-11-05T12:00:00Z",
        ["kind"] = "deep",
        ["trigger"] = "automatic",
        ["result"] = "completed",
        ["durationMs"] = 900,
    };

    private static JsonObject LivreState() => new()
    {
        ["requestId"] = Guid.NewGuid().ToString(),
        ["supported"] = true,
        ["installed"] = true,
        ["isHome"] = false,
        ["version"] = "3.0.0",
        ["apps"] = new JsonArray(),
        ["at"] = "2026-11-05T12:30:00Z",
    };

    private static async Task<int> RowsOfAsync(TvApp app, Guid tvId)
    {
        await using var db = app.Db();
        return await db.Shortcuts.CountAsync(x => x.TvId == tvId, Ct)
            + await db.CleanupReports.CountAsync(x => x.TvId == tvId, Ct)
            + await db.TvLivre.CountAsync(x => x.TvId == tvId, Ct)
            + await db.TvLayouts.CountAsync(x => x.TvId == tvId, Ct);
    }

    private static bool Dropped(TvApp app) => app.Logs.Lines.Any(l => l.Contains(DroppedLog, StringComparison.Ordinal));

    /// <summary>
    /// A remoção está dentro do DELETE da TV (os filhos já apagados, a linha bloqueada) quando o agente fala. Antes da correção
    /// a mensagem lia a TV, que ainda existia, gravava e confirmava antes de a remoção terminar: linhas órfãs.
    /// </summary>
    [Theory]
    [InlineData("apps")]
    [InlineData("cleanup")]
    [InlineData("livre")]
    public async Task AgentMessage_ArrivingWhileTheTvIsBeingRemoved_IsDroppedAndLeavesNoRows(string kind)
    {
        await using var setup = await StartAsync();
        var app = setup.App;
        await HoldAsync(app, "BEFORE DELETE", "tv.tvs");

        var removal = app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/tvs/{setup.TvId}");
        await Task.Delay(TimeSpan.FromMilliseconds(700), Ct);
        await SendAsync(setup.Connection, kind);

        using var removed = await removal;
        removed.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await TvApp.WaitUntilAsync(async () => Dropped(app) || await RowsOfAsync(app, setup.TvId) > 0, "mensagem descartada ou gravada");

        (await RowsOfAsync(app, setup.TvId)).Should().Be(0, "a remoção prometeu apagar tudo da TV");
        Dropped(app).Should().BeTrue();
    }

    /// <summary>
    /// A mensagem já está gravando (o gatilho a segura dentro do INSERT, com a TV bloqueada) quando a remoção chega: a remoção
    /// espera o commit e então apaga o que a mensagem gravou, em vez de passar por ela e deixá-lo órfão.
    /// </summary>
    [Theory]
    [InlineData("apps", "tv.shortcuts")]
    [InlineData("cleanup", "tv.cleanup_reports")]
    [InlineData("livre", "tv.tv_livre")]
    public async Task Removal_ArrivingWhileAnAgentMessageIsBeingStored_WaitsForItAndCleansWhatItStored(string kind, string table)
    {
        await using var setup = await StartAsync();
        var app = setup.App;
        await HoldAsync(app, "BEFORE INSERT", table);

        await SendAsync(setup.Connection, kind);
        await Task.Delay(TimeSpan.FromMilliseconds(700), Ct);
        using var removed = await app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/tvs/{setup.TvId}");

        removed.StatusCode.Should().Be(HttpStatusCode.NoContent);
        // Sem a correção a remoção termina com a gravação ainda dentro do gatilho (que dura 2 s); espera o fim dela para ver a sobra.
        await Task.Delay(TimeSpan.FromSeconds(2.5), Ct);
        (await RowsOfAsync(app, setup.TvId)).Should().Be(0, "o que a mensagem gravou é apagado pela remoção, sem sobra");
        await using var check = app.Db();
        (await check.Tvs.AnyAsync(t => t.Id == setup.TvId, Ct)).Should().BeFalse();
    }

    /// <summary>O caminho normal continua gravando, só para a TV do computador que falou.</summary>
    [Fact]
    public async Task AgentMessages_OfALiveTv_AreStoredOnlyForThatTv()
    {
        await using var setup = await StartAsync();
        var app = setup.App;

        await SendAsync(setup.Connection, "apps");
        await SendAsync(setup.Connection, "cleanup");
        await SendAsync(setup.Connection, "livre");

        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.Shortcuts.CountAsync(x => x.TvId == setup.TvId, Ct) == 2
                && await db.CleanupReports.AnyAsync(x => x.TvId == setup.TvId, Ct)
                && await db.TvLivre.AnyAsync(x => x.TvId == setup.TvId && x.StateJson != null, Ct);
        }, "atalhos, relatório e estado do TV Livre gravados");

        await using var check = app.Db();
        (await check.Shortcuts.AnyAsync(x => x.TvId == setup.OtherTvId, Ct)).Should().BeFalse();
        (await check.CleanupReports.AnyAsync(x => x.TvId == setup.OtherTvId, Ct)).Should().BeFalse();
        (await check.TvLivre.AnyAsync(x => x.TvId == setup.OtherTvId, Ct)).Should().BeFalse();
        Dropped(app).Should().BeFalse();
    }

    /// <summary>A requisição do dono (salvar o layout) tem o mesmo risco: resolveu a TV e grava depois da remoção.</summary>
    [Fact]
    public async Task LayoutSave_RacingWithTheRemoval_NeverLeavesAnOrphanLayout()
    {
        await using var setup = await StartAsync();
        var app = setup.App;
        await HoldAsync(app, "BEFORE INSERT", "tv.tv_layouts");

        var saving = app.SendAsync(HttpMethod.Put, $"/api/v1/tv/layout?tvId={setup.TvId}", LayoutBody);
        await Task.Delay(TimeSpan.FromMilliseconds(700), Ct);
        using var removed = await app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/tvs/{setup.TvId}");
        using var saved = await saving;

        removed.StatusCode.Should().Be(HttpStatusCode.NoContent);
        saved.StatusCode.Should().Be(HttpStatusCode.OK, "o layout foi salvo antes de a remoção tomar a TV");
        (await RowsOfAsync(app, setup.TvId)).Should().Be(0);
    }

    /// <summary>
    /// Instalações que já acumularam linhas órfãs (de antes da correção) as perdem na migration; a linha da TV viva e a da
    /// instalação antiga (<c>Guid.Empty</c>) ficam.
    /// </summary>
    [Fact]
    public async Task OrphanMigration_DeletesRowsOfRemovedTvs_AndKeepsLiveAndLegacyOnes()
    {
        await using var setup = await StartAsync();
        var app = setup.App;
        var orphan = Guid.NewGuid();
        var started = DateTimeOffset.UtcNow;

        await using var db = app.Db();
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync("20261105120000_IndexTvRemovalAuditByUserAndDate", Ct);
        foreach (var owner in new[] { orphan, Guid.Empty, setup.TvId })
        {
            db.CleanupReports.Add(CleanupReportEntry.Skipped(owner, "deep", "automatic", started, "unknown"));
            await app.ExecuteSqlAsync($"INSERT INTO tv.tv_livre (tv_id, revision, updated_at) VALUES ('{owner}', 0, now())");
        }

        await db.SaveChangesAsync(Ct);

        await migrator.MigrateAsync(null, Ct);

        (await db.CleanupReports.AsNoTracking().Select(r => r.TvId).ToListAsync(Ct))
            .Should().BeEquivalentTo([Guid.Empty, setup.TvId]);
        (await db.TvLivre.AsNoTracking().Select(r => r.TvId).ToListAsync(Ct))
            .Should().BeEquivalentTo([Guid.Empty, setup.TvId]);
    }
}
