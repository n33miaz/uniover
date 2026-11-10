using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Domain;
using UniOver.SharedKernel;

namespace UniOver.IntegrationTests.Devices.ClientEvents;

/// <summary>
/// A telemetria de erros do app: qualquer conta ativa manda (dono ou convidado), só o dono lê, nada fora da forma fixa é guardado,
/// reenviar não duplica, a retenção é de 7 dias e há teto de linhas e de envios. Host real, Postgres real e relógio falso.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class ClientEventsTests(PostgresFixture postgres)
{
    private const string Url = "/api/v1/devices/client-events";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static JsonObject Event(Guid id, DateTimeOffset at, string kind = "command-failure", string module = "tv", string code = "network") =>
        new()
        {
            ["id"] = id.ToString(),
            ["at"] = at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture),
            ["kind"] = kind,
            ["module"] = module,
            ["code"] = code,
            ["status"] = null,
            ["traceId"] = "4bf92f3577b34da6a3ce929d0e0e4736",
            ["transport"] = "cloud",
            ["visibility"] = "visible",
            ["route"] = "/tv",
            ["api"] = "/api/v1/tv/keys",
            ["version"] = "0.54.0",
            ["grace"] = false,
        };

    private static JsonObject Batch(params JsonObject[] events) => new() { ["events"] = new JsonArray([.. events.Select(e => (JsonNode)e)]) };

    private static async Task<int> CountAsync(DevicesApp app)
    {
        await using var db = app.Db();
        return await db.ClientEvents.CountAsync(Ct);
    }

    [Fact]
    public async Task AnOwnerBatchIsStored_AndTheOwnerReadsItNewestFirst()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var now = app.Time.GetUtcNow();

        using var post = await app.SendAsync(HttpMethod.Post, Url, Batch(
            Event(Guid.NewGuid(), now.AddMinutes(-10), code: "primeiro"),
            Event(Guid.NewGuid(), now.AddMinutes(-1), "http-failure", "pc", "http_503")), bearer: owner.AccessToken);

        post.StatusCode.Should().Be(HttpStatusCode.NoContent);
        using var list = await app.SendAsync(HttpMethod.Get, Url, bearer: owner.AccessToken);
        list.StatusCode.Should().Be(HttpStatusCode.OK);
        list.Headers.CacheControl!.NoStore.Should().BeTrue();
        var json = await list.Content.ReadFromJsonAsync<JsonElement>(Ct);
        json.GetProperty("retentionDays").GetInt32().Should().Be(7);
        var items = json.GetProperty("items").EnumerateArray().ToList();
        items.Select(i => i.GetProperty("code").GetString()).Should().Equal("http_503", "primeiro");
        items[0].GetProperty("module").GetString().Should().Be("pc");
        items[0].GetProperty("traceId").GetString().Should().Be("4bf92f3577b34da6a3ce929d0e0e4736");
        items[0].GetProperty("api").GetString().Should().Be("/api/v1/tv/keys");
    }

    [Fact]
    public async Task AGuestCanReport_ButOnlyTheOwnerReads_AndAnonymousIs401()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await app.NewGuestAsync(["module:training"]);
        var now = app.Time.GetUtcNow();

        using var anonymousPost = await app.SendAsync(HttpMethod.Post, Url, Batch(Event(Guid.NewGuid(), now)));
        using var guestPost = await app.SendAsync(HttpMethod.Post, Url, Batch(Event(Guid.NewGuid(), now)), bearer: guest.Login.AccessToken);
        using var anonymousGet = await app.SendAsync(HttpMethod.Get, Url);
        using var guestGet = await app.SendAsync(HttpMethod.Get, Url, bearer: guest.Login.AccessToken);
        using var ownerGet = await app.SendAsync(HttpMethod.Get, Url, bearer: owner.AccessToken);

        anonymousPost.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        guestPost.StatusCode.Should().Be(HttpStatusCode.NoContent);
        anonymousGet.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        guestGet.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        ownerGet.StatusCode.Should().Be(HttpStatusCode.OK);
        (await CountAsync(app)).Should().Be(1);
        await using var db = app.Db();
        (await db.ClientEvents.SingleAsync(Ct)).UserId.Should().Be(guest.UserId);
    }

    [Fact]
    public async Task NothingOutsideTheFixedShapeIsStored_AndTheOtherEventsOfTheBatchStay()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var now = app.Time.GetUtcNow();
        var good = Event(Guid.NewGuid(), now, code: "TypeError");
        var freeText = Event(Guid.NewGuid(), now, code: "senha=1234 digitada pelo usuario");
        var withQuery = Event(Guid.NewGuid(), now);
        withQuery["route"] = "/tv?token=segredo";
        var badKind = Event(Guid.NewGuid(), now, kind: "outro");

        using var post = await app.SendAsync(HttpMethod.Post, Url, Batch(good, freeText, withQuery, badKind), bearer: owner.AccessToken);

        post.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        var rows = await db.ClientEvents.ToListAsync(Ct);
        rows.Should().ContainSingle().Which.Code.Should().Be("TypeError");
    }

    [Fact]
    public async Task ResendingTheSameBatchStoresNothingTwice()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var batch = Batch(Event(Guid.NewGuid(), app.Time.GetUtcNow()));

        using var first = await app.SendAsync(HttpMethod.Post, Url, batch, bearer: owner.AccessToken);
        using var second = await app.SendAsync(HttpMethod.Post, Url, batch, bearer: owner.AccessToken);

        first.StatusCode.Should().Be(HttpStatusCode.NoContent);
        second.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await CountAsync(app)).Should().Be(1);
    }

    [Theory]
    [InlineData("""{ "events": [] }""")]
    [InlineData("""{ }""")]
    public async Task AnEmptyBatchIsA400(string json)
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await app.SendAsync(HttpMethod.Post, Url, JsonNode.Parse(json), bearer: owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ABatchOverTheLimitIsA400()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var now = app.Time.GetUtcNow();
        var events = Enumerable.Range(0, 21).Select(_ => Event(Guid.NewGuid(), now)).ToArray();

        using var response = await app.SendAsync(HttpMethod.Post, Url, Batch(events), bearer: owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await CountAsync(app)).Should().Be(0);
    }

    [Fact]
    public async Task ADeviceClockOutOfReachIsReplacedByTheReceiveTime()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var now = app.Time.GetUtcNow();
        var future = Guid.NewGuid();
        var ancient = Guid.NewGuid();

        using var post = await app.SendAsync(HttpMethod.Post, Url, Batch(Event(future, now.AddHours(3)), Event(ancient, now.AddDays(-30))), bearer: owner.AccessToken);

        post.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        var rows = await db.ClientEvents.ToDictionaryAsync(e => e.EventId, Ct);
        rows[future].At.Should().BeCloseTo(now, TimeSpan.FromSeconds(2));
        rows[ancient].At.Should().BeCloseTo(now, TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task RetentionDropsWhatIsOlderThanSevenDays_WhenTheNextBatchArrives()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        await SeedAsync(app, 1, app.Time.GetUtcNow());
        app.Time.Advance(TimeSpan.FromDays(8));
        var owner = await app.LoginAsync();

        using var post = await app.SendAsync(HttpMethod.Post, Url, Batch(Event(Guid.NewGuid(), app.Time.GetUtcNow(), code: "novo")), bearer: owner.AccessToken);

        post.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        (await db.ClientEvents.Select(e => e.Code).ToListAsync(Ct)).Should().Equal("novo");
    }

    [Fact]
    public async Task TheTableNeverPassesTheRowCap_TheOldestLeaveFirst()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        await SeedAsync(app, 2_000, now.AddHours(-2));
        var owner = await app.LoginAsync();

        using var post = await app.SendAsync(HttpMethod.Post, Url, Batch(Event(Guid.NewGuid(), now, code: "novo")), bearer: owner.AccessToken);

        post.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await CountAsync(app)).Should().Be(2_000);
        await using var db = app.Db();
        (await db.ClientEvents.AnyAsync(e => e.Code == "novo", Ct)).Should().BeTrue();
    }

    [Fact]
    public async Task TheHourlyCapOfTheWholeApiDiscardsTheExcess()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        await SeedAsync(app, 600, now.AddMinutes(-5), receivedAt: now.AddMinutes(-5));
        var owner = await app.LoginAsync();

        using var post = await app.SendAsync(HttpMethod.Post, Url, Batch(Event(Guid.NewGuid(), now, code: "excesso")), bearer: owner.AccessToken);

        post.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        (await db.ClientEvents.AnyAsync(e => e.Code == "excesso", Ct)).Should().BeFalse();
    }

    [Fact]
    public async Task TheReadCanFilterByModule_AndRefusesWhatIsNotOne()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var now = app.Time.GetUtcNow();
        using var post = await app.SendAsync(HttpMethod.Post, Url, Batch(
            Event(Guid.NewGuid(), now.AddMinutes(-2), module: "tv", code: "da-tv"),
            Event(Guid.NewGuid(), now.AddMinutes(-1), module: "pc", code: "do-pc")), bearer: owner.AccessToken);
        post.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var onlyPc = await app.SendAsync(HttpMethod.Get, Url + "?module=pc", bearer: owner.AccessToken);
        using var badModule = await app.SendAsync(HttpMethod.Get, Url + "?module=financeiro", bearer: owner.AccessToken);
        using var badLimit = await app.SendAsync(HttpMethod.Get, Url + "?limit=0", bearer: owner.AccessToken);

        var items = (await onlyPc.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("items").EnumerateArray().ToList();
        items.Should().ContainSingle().Which.GetProperty("code").GetString().Should().Be("do-pc");
        badModule.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        badLimit.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task TheAccountIsTakenFromTheSession_NeverFromTheBody_AndTheOwnerListsEveryAccount()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await app.NewGuestAsync(["module:training"]);
        var now = app.Time.GetUtcNow();
        using var me = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: owner.AccessToken);
        var ownerId = (await me.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("id").GetGuid();

        // O corpo tenta se passar por outra conta: o campo é ignorado.
        var forged = Event(Guid.NewGuid(), now, code: "da-convidada");
        forged["userId"] = ownerId.ToString();
        using var guestPost = await app.SendAsync(HttpMethod.Post, Url, Batch(forged), bearer: guest.Login.AccessToken);
        using var ownerPost = await app.SendAsync(HttpMethod.Post, Url, Batch(Event(Guid.NewGuid(), now.AddSeconds(1), code: "do-dono")), bearer: owner.AccessToken);

        guestPost.StatusCode.Should().Be(HttpStatusCode.NoContent);
        ownerPost.StatusCode.Should().Be(HttpStatusCode.NoContent);
        using var list = await app.SendAsync(HttpMethod.Get, Url, bearer: owner.AccessToken);
        var items = (await list.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("items").EnumerateArray().ToList();
        items.Should().HaveCount(2);
        items.Single(i => i.GetProperty("code").GetString() == "da-convidada").GetProperty("userId").GetGuid().Should().Be(guest.UserId);
        items.Single(i => i.GetProperty("code").GetString() == "do-dono").GetProperty("userId").GetGuid().Should().Be(ownerId);
    }

    [Fact]
    public async Task TheTableHoldsTheAccountAndNothingElseThatIdentifiesAPerson()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        await using var db = app.Db();

        var entity = db.Model.FindEntityType(typeof(ClientEvent))!;
        var columns = entity.GetProperties().Select(p => p.GetColumnName()).ToList();

        // A conta é um valor solto (sem chave estrangeira); nada de endereço de rede, navegador, e-mail ou texto de erro.
        columns.Should().Contain("user_id");
        entity.GetForeignKeys().Should().BeEmpty();
        columns.Should().NotContain(c => c.Contains("ip", StringComparison.Ordinal) || c.Contains("agent", StringComparison.Ordinal) || c.Contains("email", StringComparison.Ordinal));
        columns.Should().NotContain("message").And.NotContain("stack");
    }

    [Fact]
    public async Task ConcurrentBatchesNeverPassTheHourlyCap()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        await SeedAsync(app, 590, now.AddMinutes(-5), receivedAt: now.AddMinutes(-5));
        var guests = new List<GuestSession>();
        for (var i = 0; i < 6; i++)
        {
            guests.Add(await app.NewGuestAsync(["module:training"], $"Convidado{i}"));
        }

        // Seis aparelhos mandam 10 ocorrências ao mesmo tempo: só cabem 10 (600 - 590).
        var posts = guests.Select((guest, index) => app.SendAsync(
            HttpMethod.Post,
            Url,
            Batch([.. Enumerable.Range(0, 10).Select(n => Event(Guid.NewGuid(), now, code: $"c{index}-{n}"))]),
            bearer: guest.Login.AccessToken)).ToList();
        var responses = await Task.WhenAll(posts);
        foreach (var response in responses)
        {
            response.StatusCode.Should().Be(HttpStatusCode.NoContent);
            response.Dispose();
        }

        await using var db = app.Db();
        var total = await db.ClientEvents.CountAsync(e => e.ReceivedAt > now.AddHours(-1), Ct);
        total.Should().BeLessThanOrEqualTo(600);
        (await db.ClientEvents.CountAsync(e => e.Code != "semente", Ct)).Should().Be(10);
    }

    private static async Task SeedAsync(DevicesApp app, int count, DateTimeOffset at, DateTimeOffset? receivedAt = null)
    {
        await using var db = app.Db();
        for (var i = 0; i < count; i++)
        {
            db.ClientEvents.Add(ClientEvent.Create(
                IdGenerator.NewId(), Guid.NewGuid(), Guid.NewGuid(), at.AddSeconds(i), receivedAt ?? at, "command-failure", "tv", "semente", null, null, null, "visible", "/tv", null, "0.54.0", false));
        }

        await db.SaveChangesAsync(Ct);
    }
}
