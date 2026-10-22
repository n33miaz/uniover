using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// O rótulo próprio de um atalho: o texto que o dono escolhe aparece na tela e na trilha, então caractere invisível, de
/// controle ou de direção (que inverte o que se lê) é recusado com 400 e nada é gravado; o que passa é guardado
/// normalizado (espaços arrumados, NFC).
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class ShortcutLabelTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<Guid> SeedShortcutAsync(TvApp app)
    {
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.exemplo.video", "Vídeo"))));
        Guid id = Guid.Empty;
        await TvApp.WaitUntilAsync(async () =>
        {
            using var response = await app.GetAsync("/api/v1/tv/shortcuts");
            var list = (await TvApp.JsonAsync(response)).EnumerateArray().ToList();
            if (list.Count == 1)
            {
                id = list[0].GetProperty("id").GetGuid();
            }

            return id != Guid.Empty;
        }, "o atalho apareceu");
        return id;
    }

    private static Task<HttpResponseMessage> PatchAsync(TvApp app, Guid id, object body) =>
        app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/shortcuts/{id}", body);

    [Theory]
    [InlineData("\U0000202Eevil")]              // sobreposição da direita para a esquerda
    [InlineData("a\U0000200Eb")]                // marca de direção
    [InlineData("a\U0000200Bb")]                // espaço de largura zero
    [InlineData("a\U0000200Db")]                // junção de largura zero entre letras
    [InlineData("a\U00002028b")]                // separador de linha
    [InlineData("\U0000FEFFvideo")]             // marca de ordem de byte
    [InlineData("a\U0000001Fb")]                // controle
    public async Task ALabelWithInvisibleOrDirectionCharacters_IsRefusedWith400_AndNothingChanges(string label)
    {
        await using var app = await TvApp.StartAsync(postgres);
        var id = await SeedShortcutAsync(app);

        using var response = await PatchAsync(app, id, new { customLabel = label });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var problem = await TvApp.JsonAsync(response);
        problem.GetProperty("errors").TryGetProperty("customLabel", out _).Should().BeTrue();
        await using var db = app.Db();
        (await db.Shortcuts.AsNoTracking().SingleAsync(Ct)).CustomLabel.Should().BeNull("nada foi gravado");
        (await db.CommandAudit.CountAsync(a => a.Command == "tv.shortcut.update", Ct)).Should().Be(0, "e não há mudança a registrar");
    }

    [Fact]
    public async Task ALabelWithMessySpaces_IsStoredNormalized_AndTheResponseShowsTheStoredOne()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var id = await SeedShortcutAsync(app);

        using var response = await PatchAsync(app, id, new { customLabel = "  Meu\U000000A0  app  " });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("customLabel").GetString().Should().Be("Meu app");
        await using var db = app.Db();
        (await db.Shortcuts.AsNoTracking().SingleAsync(Ct)).CustomLabel.Should().Be("Meu app");
    }

    [Fact]
    public async Task ACompoundEmoji_KeepsItsJoiner()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var id = await SeedShortcutAsync(app);

        using var response = await PatchAsync(app, id, new { customLabel = "\U0001F469\U0000200D\U0001F4BB TV" });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("customLabel").GetString().Should().Be("\U0001F469\U0000200D\U0001F4BB TV");
    }

    [Fact]
    public async Task ABlankLabel_StillClearsTheOwnLabel()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var id = await SeedShortcutAsync(app);
        (await PatchAsync(app, id, new { customLabel = "Meu app" })).Dispose();

        using var response = await PatchAsync(app, id, new { customLabel = "   " });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("customLabel").ValueKind.Should().Be(JsonValueKind.Null);
    }
}
