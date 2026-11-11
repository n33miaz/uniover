using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training;

namespace UniOver.IntegrationTests.Shopping;

/// <summary>O caminho de uma ida ao mercado e as regras da sincronização: operação idempotente, ordem do servidor e lápide.</summary>
[Collection(PostgresGroup.Name)]
public sealed class ShoppingEndpointsTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task OpeningTheModule_CreatesOneGroup_AndKeepsIt()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);

        var first = await ShoppingClient.OkAsync(owner.GetAsync("/group"));
        var second = await ShoppingClient.OkAsync(owner.GetAsync("/group"));

        first.GetProperty("isOwner").GetBoolean().Should().BeTrue();
        second.GetProperty("id").GetGuid().Should().Be(first.GetProperty("id").GetGuid());
        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        (await db.Groups.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ATripToTheMarket_FromTheListToTheClosedPurchase_AndTheLastPrice()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var coffee = await owner.NewProductAsync("Café");
        var rice = await owner.NewProductAsync("Arroz 5 kg");
        var soap = await owner.NewProductAsync("Sabão", "Limpeza");
        await owner.NewListItemAsync(coffee, 2);
        await owner.NewListItemAsync(rice);
        await owner.NewListItemAsync(soap, needed: false);

        var purchase = await owner.OpenPurchaseAsync(budget: 100);

        // Só o que "precisa" entra na compra; as linhas chegam pelo feed, cada uma com a compra a que pertence.
        var lines = (await owner.ChangesAsync()).Where(x => x.GetProperty("entityType").GetString() == "purchaseItem").ToList();
        lines.Should().HaveCount(2);
        lines.Should().OnlyContain(x => x.GetProperty("payload").GetProperty("purchaseId").GetGuid() == purchase);
        var coffeeLine = lines.Single(x => x.GetProperty("payload").GetProperty("productId").GetGuid() == coffee).GetProperty("entityId").GetGuid();

        await ShoppingClient.OkAsync(owner.WriteAsync(
            HttpMethod.Put,
            $"/purchases/{purchase}/items/{coffeeLine}",
            new() { ["productId"] = coffee, ["quantity"] = 2, ["unitPrice"] = 18.5m, ["picked"] = true }));

        var open = await ShoppingClient.OkAsync(owner.GetAsync("/purchases?closed=false"));
        open.GetArrayLength().Should().Be(1);
        open[0].GetProperty("pickedTotal").GetDecimal().Should().Be(37m);
        open[0].GetProperty("purchase").GetProperty("budget").GetDecimal().Should().Be(100m);

        using (var none = await owner.GetAsync($"/products/{coffee}/last-price"))
        {
            none.StatusCode.Should().Be(HttpStatusCode.NoContent, "a compra ainda está aberta");
        }

        var closed = await ShoppingClient.OkAsync(owner.WriteAsync(
            HttpMethod.Post, $"/purchases/{purchase}/close", new() { ["totalPaid"] = 37.2m, ["store"] = " Mercado da Esquina " }));
        closed.GetProperty("status").GetString().Should().Be("closed");
        closed.GetProperty("store").GetString().Should().Be("Mercado da Esquina");

        var last = await ShoppingClient.OkAsync(owner.GetAsync($"/products/{coffee}/last-price"));
        last.GetProperty("unitPrice").GetDecimal().Should().Be(18.5m);
        last.GetProperty("store").GetString().Should().Be("Mercado da Esquina");

        // Compra fechada não recebe mais linha; fechar de novo não muda o primeiro fechamento.
        using (var late = await owner.WriteAsync(
            HttpMethod.Put, $"/purchases/{purchase}/items/{Guid.NewGuid()}", new() { ["productId"] = soap, ["quantity"] = 1, ["picked"] = true }))
        {
            late.StatusCode.Should().Be(HttpStatusCode.Conflict);
        }

        var again = await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Post, $"/purchases/{purchase}/close", new() { ["totalPaid"] = 1m }));
        again.GetProperty("totalPaid").GetDecimal().Should().Be(37.2m);
        (await ShoppingClient.OkAsync(owner.GetAsync("/purchases?closed=true"))).GetArrayLength().Should().Be(1);
    }

    [Fact]
    public async Task TheSameOperationSentAgain_IsAppliedOnce_EvenWithAnotherIdempotencyKey()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var id = Guid.NewGuid();
        var operation = Guid.NewGuid();

        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/products/{id}", new() { ["name"] = "Leite" }, operation));
        var replay = await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/products/{id}", new() { ["name"] = "Outro nome" }, operation));

        replay.GetProperty("name").GetString().Should().Be("Leite", "o reenvio devolve o estado atual, sem aplicar de novo");
        (await owner.ChangesAsync()).Should().HaveCount(1);

        using var empty = await owner.WriteAsync(HttpMethod.Put, $"/products/{Guid.NewGuid()}", new() { ["name"] = "Pão" }, Guid.Empty);
        empty.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task TheFeed_FollowsTheServerOrder_PagesByCursor_AndCarriesTombstones()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var id = Guid.NewGuid();
        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/products/{id}", new() { ["name"] = "Feijão" }));
        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/products/{id}", new() { ["name"] = "Feijão preto" }));
        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/products/{id}", new() { ["deleted"] = true }));

        var first = await ShoppingClient.OkAsync(owner.GetAsync("/changes?after=0&limit=2"));
        first.GetProperty("hasMore").GetBoolean().Should().BeTrue();
        first.GetProperty("groupId").GetGuid().Should().Be(await owner.GroupIdAsync());
        var cursor = first.GetProperty("nextCursor").GetInt64();
        var rest = await ShoppingClient.OkAsync(owner.GetAsync($"/changes?after={cursor}"));
        rest.GetProperty("hasMore").GetBoolean().Should().BeFalse();

        var all = first.GetProperty("items").EnumerateArray().Concat(rest.GetProperty("items").EnumerateArray()).ToList();
        all.Select(x => x.GetProperty("sequence").GetInt64()).Should().BeInAscendingOrder().And.OnlyHaveUniqueItems();
        all.Select(x => x.GetProperty("payload").GetProperty("name").GetString()).Should().Equal("Feijão", "Feijão preto", "Feijão preto");
        all[^1].GetProperty("payload").GetProperty("deleted").GetBoolean().Should().BeTrue("a exclusão é uma lápide no feed");

        // Depois do fim, o cursor não anda para trás nem inventa linha.
        var after = await ShoppingClient.OkAsync(owner.GetAsync($"/changes?after={rest.GetProperty("nextCursor").GetInt64()}"));
        after.GetProperty("items").GetArrayLength().Should().Be(0);
        after.GetProperty("nextCursor").GetInt64().Should().Be(rest.GetProperty("nextCursor").GetInt64());

        using var bad = await owner.GetAsync("/changes?limit=0");
        bad.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ProductNames_AreUniqueInTheGroup_IgnoringAccentAndCase_AndATombstoneFreesTheName()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var sugar = await owner.NewProductAsync("Açúcar");

        using (var duplicate = await owner.WriteAsync(HttpMethod.Put, $"/products/{Guid.NewGuid()}", new() { ["name"] = " acucar " }))
        {
            duplicate.StatusCode.Should().Be(HttpStatusCode.Conflict);
        }

        using (var missing = await owner.WriteAsync(HttpMethod.Put, $"/products/{Guid.NewGuid()}", new() { ["deleted"] = true }))
        {
            missing.StatusCode.Should().Be(HttpStatusCode.NotFound, "lápide de um registro que não existe não cria nada");
        }

        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/products/{sugar}", new() { ["deleted"] = true }));
        await owner.NewProductAsync("ACUCAR");
    }

    [Fact]
    public async Task ConcurrentWrites_InTheSameGroup_AllLand_WithOneSequenceEach()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        await owner.GroupIdAsync();

        var writes = Enumerable.Range(0, 8)
            .Select(i => owner.WriteAsync(HttpMethod.Put, $"/products/{Guid.NewGuid()}", new() { ["name"] = $"Produto {i}" }))
            .ToList();
        foreach (var response in await Task.WhenAll(writes))
        {
            response.StatusCode.Should().Be(HttpStatusCode.OK);
            response.Dispose();
        }

        var changes = await owner.ChangesAsync();
        changes.Should().HaveCount(8);
        changes.Select(x => x.GetProperty("sequence").GetInt64()).Should().BeInAscendingOrder().And.OnlyHaveUniqueItems();
    }
}
