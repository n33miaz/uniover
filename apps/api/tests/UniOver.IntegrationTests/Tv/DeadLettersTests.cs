using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// Os eventos que esgotaram as tentativas saem da fila e ficam em <c>dead_letters</c>, uma tabela por módulo. A rota do dono
/// os junta, mostra o que falhou, quando e por quê, e nunca o conteúdo do evento.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class DeadLettersTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string Insert(string schema, Guid id, string type, string payload, int attempts, string failedAt) =>
        $"INSERT INTO {schema}.dead_letters (id, type, payload, occurred_at, failed_at, attempts, last_error) " +
        $"VALUES ('{id}', '{type}', '{payload}'::jsonb, '{failedAt}', '{failedAt}', {attempts}, 'InvalidOperationException')";

    [Fact]
    public async Task TheOwnerSeesTheDeadLettersOfEveryModule_NewestFirst_WithoutThePayload()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var older = Guid.NewGuid();
        var newer = Guid.NewGuid();
        await app.ExecuteSqlAsync(Insert("tv", older, "tv.state-changed.v1", "{\"segredo\":\"conteudo-do-evento\"}", 8, "2026-10-30T10:00:00Z"));
        await app.ExecuteSqlAsync(Insert("devices", newer, "devices.agent-revoked.v1", "{\"segredo\":\"conteudo-do-evento\"}", 8, "2026-10-31T10:00:00Z"));

        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/system/dead-letters");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var raw = await response.Content.ReadAsStringAsync(Ct);
        raw.Should().NotContain("conteudo-do-evento").And.NotContain("payload");
        var report = JsonDocument.Parse(raw).RootElement;
        report.GetProperty("total").GetInt32().Should().Be(2);
        report.GetProperty("unavailableModules").GetArrayLength().Should().Be(0);
        var items = report.GetProperty("items").EnumerateArray().ToList();
        items.Select(i => i.GetProperty("id").GetGuid()).Should().Equal(newer, older);
        items[0].GetProperty("module").GetString().Should().Be("devices");
        items[0].GetProperty("type").GetString().Should().Be("devices.agent-revoked.v1");
        items[0].GetProperty("attempts").GetInt32().Should().Be(8);
        items[0].GetProperty("lastError").GetString().Should().Be("InvalidOperationException");
    }

    [Fact]
    public async Task WithNoDeadLetters_TheReportIsEmpty()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/system/dead-letters");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var report = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct)).RootElement;
        report.GetProperty("total").GetInt32().Should().Be(0);
        report.GetProperty("items").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task OnlyTheOwnerReadsThem_AnonymousIs401_AndAGuestIs403()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("leitor", ["module:tv"], 31);

        using var anonymous = await app.SendAsync(HttpMethod.Get, "/api/v1/system/dead-letters", bearer: null);
        using var asGuest = await app.SendAsync(HttpMethod.Get, "/api/v1/system/dead-letters", bearer: guest.Login.AccessToken);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
