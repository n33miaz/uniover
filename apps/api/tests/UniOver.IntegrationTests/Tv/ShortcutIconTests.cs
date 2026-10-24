using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class ShortcutIconTests(PostgresFixture postgres) : IDisposable
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose() => NpgsqlConnection.ClearAllPools();

    /// <summary>Bytes que começam como PNG: a borda confere a assinatura, não decodifica a imagem.</summary>
    private static byte[] Png(int length = 120, byte fill = 9)
    {
        var data = new byte[length];
        Array.Fill(data, fill);
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }.CopyTo(data, 0);
        return data;
    }

    private static string DataUri(byte[] png) => "data:image/png;base64," + Convert.ToBase64String(png);

    private static JsonObject IconNode(string mime, string data) => new() { ["mime"] = mime, ["data"] = data };

    private static JsonObject AppsV2(params (string Package, string? Label, JsonObject? Icon)[] apps) =>
        new()
        {
            ["apps"] = new JsonArray([.. apps.Select(a =>
            {
                var node = new JsonObject { ["package"] = a.Package, ["label"] = a.Label };
                if (a.Icon is not null)
                {
                    node["icon"] = a.Icon.DeepClone();
                }

                return (JsonNode)node;
            })]),
            ["at"] = "2026-10-20T12:00:00Z",
        };

    private static async Task<List<JsonElement>> ShortcutsAsync(TvApp app)
    {
        using var response = await app.GetAsync("/api/v1/tv/shortcuts");
        return (await TvApp.JsonAsync(response)).EnumerateArray().Select(e => e.Clone()).ToList();
    }

    private static async Task<List<JsonElement>> WaitShortcutsAsync(TvApp app, Func<List<JsonElement>, bool> ready, string what)
    {
        List<JsonElement> list = [];
        await TvApp.WaitUntilAsync(async () =>
        {
            list = await ShortcutsAsync(app);
            return ready(list);
        }, what);
        return list;
    }

    private static JsonElement Of(List<JsonElement> list, string package) =>
        list.Single(s => s.GetProperty("package").GetString() == package);

    [Fact]
    public async Task IconsFromTheAgent_ComeBackAsDataUris_AndTheOwnersChoicesSurvive()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();

        // Primeiro a lista sem ícones (como sempre foi), depois a lista com eles.
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.a.um", "Um"), ("com.b.dois", "Dois"), ("com.c.tres", "Três"))));
        var list = await WaitShortcutsAsync(app, l => l.Count == 3, "3 atalhos");
        list.Should().OnlyContain(s => s.GetProperty("iconDataUri").ValueKind == JsonValueKind.Null);

        var secondId = Of(list, "com.b.dois").GetProperty("id").GetGuid();
        var thirdId = Of(list, "com.c.tres").GetProperty("id").GetGuid();
        (await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{secondId}", new { customLabel = "Meu streaming" })).Dispose();
        (await app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{thirdId}", new { enabled = false })).Dispose();

        var png = Png();
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(
            ("com.a.um", "Um", IconNode("image/png", Convert.ToBase64String(png))),
            ("com.b.dois", "Dois", IconNode("image/png", Convert.ToBase64String(Png(fill: 4)))),
            ("com.c.tres", "Três", null))));
        var withIcons = await WaitShortcutsAsync(
            app, l => l.Count == 3 && Of(l, "com.b.dois").GetProperty("iconDataUri").ValueKind == JsonValueKind.String, "ícones gravados");

        Of(withIcons, "com.a.um").GetProperty("iconDataUri").GetString().Should().Be(DataUri(png));
        Of(withIcons, "com.b.dois").GetProperty("iconDataUri").GetString().Should().Be(DataUri(Png(fill: 4)));
        Of(withIcons, "com.c.tres").GetProperty("iconDataUri").ValueKind.Should().Be(JsonValueKind.Null);

        // Nome próprio, ocultação e posição do dono não foram tocados.
        var second = Of(withIcons, "com.b.dois");
        second.GetProperty("customLabel").GetString().Should().Be("Meu streaming");
        second.GetProperty("position").GetInt32().Should().Be(2);
        Of(withIcons, "com.c.tres").GetProperty("enabled").GetBoolean().Should().BeFalse();
        withIcons.Select(s => s.GetProperty("position").GetInt32()).Should().Equal(1, 2, 3);

        await using var db = app.Db();
        var row = await db.Shortcuts.AsNoTracking().SingleAsync(s => s.Package == "com.a.um", Ct);
        row.IconMime.Should().Be("image/png");
        row.IconData.Should().Equal(png);
        row.IconSha256.Should().HaveLength(64);
    }

    [Fact]
    public async Task ALaterListWithoutIcons_DoesNotEraseWhatWasStored()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var png = Png();
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(("com.a.um", "Um", IconNode("image/png", Convert.ToBase64String(png))))));
        await WaitShortcutsAsync(app, l => l.Count == 1 && l[0].GetProperty("iconDataUri").ValueKind == JsonValueKind.String, "ícone gravado");

        // Lista nova do agente antigo (v1) e uma v2 sem o campo `icon`: nenhuma apaga o ícone.
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.a.um", "Um novo nome da TV"))));
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(("com.a.um", "Um", null), ("com.b.dois", "Dois", null))));
        var list = await WaitShortcutsAsync(app, l => l.Count == 2, "segundo atalho");

        Of(list, "com.a.um").GetProperty("iconDataUri").GetString().Should().Be(DataUri(png));
        Of(list, "com.b.dois").GetProperty("iconDataUri").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task TheSameIconAgain_WritesNothing_AndANewOneReplacesTheOld()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var first = Convert.ToBase64String(Png());
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(("com.a.um", "Um", IconNode("image/png", first)))));
        await WaitShortcutsAsync(app, l => l.Count == 1 && l[0].GetProperty("iconDataUri").ValueKind == JsonValueKind.String, "ícone gravado");
        await using var db = app.Db();
        var stored = (await db.Shortcuts.AsNoTracking().SingleAsync(Ct)).UpdatedAt;

        app.Time.Advance(TimeSpan.FromMinutes(5));
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(("com.a.um", "Um", IconNode("image/png", first)))));
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(("com.a.um", "Um", IconNode("image/png", Convert.ToBase64String(Png(fill: 77)))))));
        await WaitShortcutsAsync(app, l => l.Count == 1 && l[0].GetProperty("iconDataUri").GetString() == DataUri(Png(fill: 77)), "ícone trocado");

        // A mensagem repetida foi processada antes da troca e não regravou nada; a troca atualizou a linha.
        (await db.Shortcuts.AsNoTracking().SingleAsync(Ct)).UpdatedAt.Should().BeAfter(stored);
    }

    [Fact]
    public async Task ABadIcon_InsideTheContractShape_IsDroppedWithAWarning_AndTheAppStays()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        // Base64 válido e dentro dos limites, mas o conteúdo não é um PNG: o contrato deixa passar, a borda não.
        var notAnImage = Convert.ToBase64String("<html><script>alert(1)</script></html>"u8.ToArray());
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(
            ("com.a.ruim", "Ruim", IconNode("image/png", notAnImage)),
            ("com.b.bom", "Bom", IconNode("image/png", Convert.ToBase64String(Png()))))));

        var list = await WaitShortcutsAsync(app, l => l.Count == 2, "dois atalhos");

        Of(list, "com.a.ruim").GetProperty("iconDataUri").ValueKind.Should().Be(JsonValueKind.Null);
        Of(list, "com.b.bom").GetProperty("iconDataUri").ValueKind.Should().Be(JsonValueKind.String);
        app.Logs.Lines.Should().Contain(l => l.Contains("com.a.ruim", StringComparison.Ordinal) && l.Contains("recusado", StringComparison.Ordinal));
        app.Logs.Lines.Should().NotContain(l => l.Contains(notAnImage, StringComparison.Ordinal), "o conteúdo do ícone nunca vai para o registro");
    }

    [Fact]
    public async Task AnOversizedIcon_IsRefusedAtTheEdge_AndNothingOfThatMessageIsApplied()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var oversized = new string('A', 43_696);
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(("com.a.grande", "Grande", IconNode("image/png", oversized)))));
        // Mime fora do enum e base64 inválido também não passam do contrato.
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(("com.b.gif", "Gif", IconNode("image/gif", Convert.ToBase64String(Png()))))));
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(("com.c.lixo", "Lixo", IconNode("image/png", "isto não é base64!!")))));
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.d.valido", "Válido"))));

        var list = await WaitShortcutsAsync(app, l => l.Count >= 1, "o atalho válido");

        list.Select(s => s.GetProperty("package").GetString()).Should().Equal("com.d.valido");
    }

    [Fact]
    public async Task AMessageNearTheTransportBudget_IsAcceptedEndToEnd()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        // Um ícone no teto de 32 KB (43.692 caracteres) e uma lista longa: perto dos 60 KB que o agente se permite.
        var icon = Convert.ToBase64String(Png(32 * 1024));
        icon.Length.Should().Be(43_692);
        var apps = new List<(string, string?, JsonObject?)> { ("com.a.grande", "Grande", IconNode("image/png", icon)) };
        apps.AddRange(Enumerable.Range(0, 100).Select(i => ($"com.exemplo.app{i}", (string?)new string('x', 100), (JsonObject?)null)));
        var envelope = agent.Envelope("tv.apps.v2", AppsV2([.. apps]));
        System.Text.Encoding.UTF8.GetByteCount(envelope).Should().BeInRange(55_000, 60_000);

        await agent.SendTextAsync(envelope);

        var list = await WaitShortcutsAsync(app, l => l.Count == 101, "101 atalhos");
        Of(list, "com.a.grande").GetProperty("iconDataUri").GetString().Should().Be(DataUri(Png(32 * 1024)));
        agent.Closed.Should().BeNull("a mensagem coube no limite do transporte");
    }

    [Fact]
    public async Task IconsAreAlsoPushedToTheScreenStream_OnTheShortcutsEvent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var png = Png();
        await agent.SendTextAsync(agent.Envelope("tv.apps.v2", AppsV2(("com.a.um", "Um", IconNode("image/png", Convert.ToBase64String(png))))));
        await WaitShortcutsAsync(app, l => l.Count == 1 && l[0].GetProperty("iconDataUri").ValueKind == JsonValueKind.String, "ícone gravado");

        // O instantâneo do fluxo (aberto depois) já leva a lista com o ícone.
        var ticket = await app.StreamTicketAsync();
        using var response = await app.OpenEventsAsync(ticket);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(Ct));
        var seen = string.Empty;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        while (!seen.Contains("tv.shortcuts", StringComparison.Ordinal) || !seen.Contains("iconDataUri", StringComparison.Ordinal))
        {
            var line = await reader.ReadLineAsync(timeout.Token);
            line.Should().NotBeNull();
            seen += line + "\n";
        }

        seen.Should().Contain(DataUri(png));
    }

    // ---- migration ----

    [Fact]
    public async Task IconMigration_OverAnExistingShortcut_KeepsTheRow_AndLeavesTheIconNull()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using (var context = TvApp.CreateContext(database.OwnerConnection))
        {
            var migrator = context.GetService<IMigrator>();
            await migrator.MigrateAsync("20261019125652_InitialCreate", Ct);
            await context.Database.ExecuteSqlAsync(
                $"""
                INSERT INTO tv.shortcuts (id, package, tv_label, custom_label, "position", enabled, installed, updated_at)
                VALUES ('0192f1e4-0000-7000-8000-000000000001', {"com.cnvs.apptv"}, {"CineVS"}, {"Meu filme"}, {3}, {false}, {true}, now())
                """, Ct);
            await migrator.MigrateAsync("20261021160237_AddTvs", Ct);
            await context.Database.ExecuteSqlAsync(
                $"""
                INSERT INTO tv.tvs (id, name, agent_slug, is_default, created_at, updated_at, updated_by)
                VALUES ('0192f1e4-0000-7000-8000-000000000002', 'TV', 'pc-casa', true, now(), now(), '0192f1e4-0000-7000-8000-000000000003')
                """, Ct);
            await context.Database.ExecuteSqlAsync(
                $"""
                INSERT INTO tv.command_audit (id, user_id, command, detail, ok, occurred_at)
                VALUES ('0192f1e4-0000-7000-8000-000000000004', '0192f1e4-0000-7000-8000-000000000005', 'tv.key', 'HOME', true, now())
                """, Ct);
            await migrator.MigrateAsync(null, Ct);
        }

        await using var conn = new NpgsqlConnection(database.OwnerConnection);
        await conn.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(
            "SELECT package, custom_label, \"position\", enabled, icon_mime, icon_data, icon_sha256, tv_id FROM tv.shortcuts", conn);
        await using var reader = await command.ExecuteReaderAsync(Ct);
        (await reader.ReadAsync(Ct)).Should().BeTrue();
        reader.GetString(0).Should().Be("com.cnvs.apptv");
        reader.GetString(1).Should().Be("Meu filme");
        reader.GetInt32(2).Should().Be(3);
        reader.GetBoolean(3).Should().BeFalse();
        reader.IsDBNull(4).Should().BeTrue();
        reader.IsDBNull(5).Should().BeTrue();
        reader.IsDBNull(6).Should().BeTrue();
        reader.GetGuid(7).Should().Be(Guid.Parse("0192f1e4-0000-7000-8000-000000000002"), "o atalho legado pertence à TV padrão");
        (await reader.ReadAsync(Ct)).Should().BeFalse();
        await reader.CloseAsync();

        await using var audit = new NpgsqlCommand("SELECT tv_id FROM tv.command_audit", conn);
        (await audit.ExecuteScalarAsync(Ct)).Should().Be(Guid.Parse("0192f1e4-0000-7000-8000-000000000002"), "a auditoria legada pertence à TV padrão");

        // Só se acrescentou: as colunas novas são anuláveis e a migration anterior segue no histórico, intacta.
        await using var history = new NpgsqlCommand("SELECT migration_id FROM tv.__ef_migrations_history ORDER BY migration_id", conn);
        await using var rows = await history.ExecuteReaderAsync(Ct);
        var applied = new List<string>();
        while (await rows.ReadAsync(Ct))
        {
            applied.Add(rows.GetString(0));
        }

        applied.Should().HaveCountGreaterThanOrEqualTo(2, "as migrations seguintes só acrescentam");
        applied[0].Should().Be("20261019125652_InitialCreate");
        applied[1].Should().EndWith("_AddShortcutIcons");
    }

    [Fact]
    public async Task TheRuntimeRole_CanReadAndWriteTheIconColumns()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using (var owner = TvApp.CreateContext(database.OwnerConnection))
        {
            await owner.Database.MigrateAsync(Ct);
        }

        await using var runtime = new NpgsqlConnection(database.RuntimeConnection);
        await runtime.OpenAsync(Ct);
        await using var insert = new NpgsqlCommand(
            "INSERT INTO tv.shortcuts (id, tv_id, package, \"position\", enabled, installed, updated_at, icon_mime, icon_data, icon_sha256) "
            + "VALUES (@id, @tvId, @package, 1, true, true, now(), 'image/png', @data, @hash)",
            runtime);
        insert.Parameters.AddWithValue("id", Guid.CreateVersion7());
        insert.Parameters.AddWithValue("tvId", Guid.Empty);
        insert.Parameters.AddWithValue("package", "com.a.um");
        insert.Parameters.AddWithValue("data", Png());
        insert.Parameters.AddWithValue("hash", new string('a', 64));
        (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);

        await using var select = new NpgsqlCommand("SELECT icon_data FROM tv.shortcuts", runtime);
        ((byte[])(await select.ExecuteScalarAsync(Ct))!).Should().Equal(Png());
    }
}
