using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training;

namespace UniOver.IntegrationTests.Shopping;

/// <summary>
/// Dois aparelhos sem sinal criam a mesma coisa (o produto, o item da lista, a linha da compra) e sincronizam depois: o
/// grupo fica com um registro só, com os valores juntados, e nenhum dos dois recebe recusa.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class ShoppingMergeTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TwoDevicesOffline_CreatingTheSameThings_EndInTheSameState_WhicheverSyncsFirst(bool guestFirst)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var (owner, ownerToken, guest, guestToken) = await TwoMembersAsync(app, 91);
        var purchase = await owner.OpenPurchaseAsync();
        var early = DateTimeOffset.UtcNow.AddMinutes(-20);
        var late = early.AddMinutes(5);

        var ownerIds = (Product: Guid.NewGuid(), Item: Guid.NewGuid(), Line: Guid.NewGuid());
        object[] ownerBatch =
        [
            Operation("product", ownerIds.Product, new { name = "Leite", section = "Frios" }),
            Operation("listItem", ownerIds.Item, new { productId = ownerIds.Product, quantity = 2, needed = false }),
            Operation("purchaseItem", ownerIds.Line, new { productId = ownerIds.Product, quantity = 1, picked = true, only = "picked" }, purchase, early),
            Operation("purchaseItem", ownerIds.Line, new { productId = ownerIds.Product, quantity = 1, picked = true, unitPrice = 5, only = "price" }, purchase, early),
        ];
        var guestIds = (Product: Guid.NewGuid(), Item: Guid.NewGuid(), Line: Guid.NewGuid());
        object[] guestBatch =
        [
            Operation("product", guestIds.Product, new { name = " leite " }),
            Operation("listItem", guestIds.Item, new { productId = guestIds.Product, quantity = 3, needed = true, note = "integral" }),
            Operation("purchaseItem", guestIds.Line, new { productId = guestIds.Product, quantity = 2, picked = false, unitPrice = 6, only = "price" }, purchase, late),
        ];

        var first = await BatchAsync(app, guestFirst ? guestToken : ownerToken, guestFirst ? guestBatch : ownerBatch);
        var second = await BatchAsync(app, guestFirst ? ownerToken : guestToken, guestFirst ? ownerBatch : guestBatch);

        first.Concat(second).Should().OnlyContain(x => x.GetProperty("status").GetInt32() == 200, "juntar não é recusar");
        var kept = guestFirst ? guestIds : ownerIds;
        second[0].GetProperty("entityId").GetGuid().Should().Be(kept.Product, "quem chega depois fica sabendo qual registro vale");
        second[1].GetProperty("entityId").GetGuid().Should().Be(kept.Item);
        second[^1].GetProperty("entityId").GetGuid().Should().Be(kept.Line);

        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        var product = await db.Products.AsNoTracking().SingleAsync(Ct);
        (product.Name, product.Section).Should().Be(("Leite", "Frios"));
        var item = await db.ListItems.AsNoTracking().SingleAsync(Ct);
        (item.ProductId, item.Needed, item.Quantity, item.Note).Should().Be((product.Id, true, 3m, "integral"));
        var line = await db.PurchaseItems.AsNoTracking().SingleAsync(Ct);
        (line.ProductId, line.Picked, line.Quantity, line.UnitPrice).Should().Be((product.Id, true, 2m, 6m));

        // Um aparelho novo, lendo o feed do começo, monta o mesmo retrato: um registro de cada, sem sobra.
        var feed = await guest.ChangesAsync();
        foreach (var type in new[] { "product", "listItem", "purchaseItem" })
        {
            feed.Where(x => x.GetProperty("entityType").GetString() == type)
                .Select(x => x.GetProperty("entityId").GetGuid()).Distinct().Should().ContainSingle(type);
        }

        feed.Last(x => x.GetProperty("entityType").GetString() == "purchaseItem").GetProperty("payload").GetProperty("unitPrice").GetDecimal().Should().Be(6m);
    }

    [Fact]
    public async Task AfterAMerge_TheOldIdsKeepWorking_AndAResentBatchChangesNothing()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var (owner, _, guest, guestToken) = await TwoMembersAsync(app, 92);
        var milk = await owner.NewProductAsync("Leite");
        var milkItem = await owner.NewListItemAsync(milk, needed: false);

        var localMilk = Guid.NewGuid();
        var localItem = Guid.NewGuid();
        object[] batch =
        [
            Operation("product", localMilk, new { name = "LEITE" }),
            Operation("listItem", localItem, new { productId = localMilk, quantity = 1, needed = true }),
        ];
        var results = await BatchAsync(app, guestToken, batch);
        results.Select(x => x.GetProperty("entityId").GetGuid()).Should().Equal(milk, milkItem);
        var feed = await guest.ChangesAsync();

        // A resposta se perdeu e o lote volta inteiro: o mesmo desfecho, o mesmo registro, nada de novo no feed.
        var again = await BatchAsync(app, guestToken, batch);
        again.Select(x => x.GetProperty("status").GetInt32()).Should().Equal(200, 200);
        again.Select(x => x.GetProperty("entityId").GetGuid()).Should().Equal(milk, milkItem);
        (await guest.ChangesAsync()).Should().HaveCount(feed.Count);

        // Um aparelho que não trocou os ids (a versão anterior do app) continua escrevendo no registro que vale.
        var later = await ShoppingClient.OkAsync(guest.WriteAsync(
            HttpMethod.Put, $"/list-items/{localItem}", new() { ["productId"] = localMilk, ["quantity"] = 4, ["needed"] = true }));
        later.GetProperty("id").GetGuid().Should().Be(milkItem);
        later.GetProperty("productId").GetGuid().Should().Be(milk);
        later.GetProperty("quantity").GetDecimal().Should().Be(4m);

        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        (await db.Products.CountAsync(Ct)).Should().Be(1);
        (await db.ListItems.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ATapFromOneDevice_NeverErasesThePriceAnotherTyped()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var (owner, _, guest, guestToken) = await TwoMembersAsync(app, 93);
        var milk = await owner.NewProductAsync("Leite");
        var purchase = await owner.OpenPurchaseAsync();
        var line = Guid.NewGuid();
        await ShoppingClient.OkAsync(owner.WriteAsync(
            HttpMethod.Put, $"/purchases/{purchase}/items/{line}", new() { ["productId"] = milk, ["quantity"] = 1, ["picked"] = true, ["unitPrice"] = 6m }));

        // O outro aparelho, sem sinal, não via a linha: criou a dele, marcou e desmarcou. Ele nunca soube do preço.
        var local = Guid.NewGuid();
        var results = await BatchAsync(
            app,
            guestToken,
            Operation("purchaseItem", local, new { productId = milk, quantity = 1, picked = true, unitPrice = (decimal?)null, only = "picked" }, purchase),
            Operation("purchaseItem", local, new { productId = milk, quantity = 1, picked = false, unitPrice = (decimal?)null, only = "picked" }, purchase));

        results.Should().OnlyContain(x => x.GetProperty("status").GetInt32() == 200 && x.GetProperty("entityId").GetGuid() == line);
        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        var kept = await db.PurchaseItems.AsNoTracking().SingleAsync(Ct);
        (kept.Id, kept.Picked, kept.UnitPrice).Should().Be((line, false, 6m));

        // O mesmo vale sem junção nenhuma: quem só toca em "peguei" numa linha que já existe não mexe no preço dela.
        await ShoppingClient.OkAsync(guest.WriteAsync(
            HttpMethod.Put, $"/purchases/{purchase}/items/{line}", new() { ["productId"] = milk, ["quantity"] = 1, ["picked"] = true, ["only"] = "picked" }));
        (await db.PurchaseItems.AsNoTracking().SingleAsync(Ct)).UnitPrice.Should().Be(6m);
    }

    [Fact]
    public async Task AMergedId_NeverLeadsIntoAnotherGroup_AndRenamingOntoAnotherProductIsStillRefused()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var (owner, ownerToken, _, _) = await TwoMembersAsync(app, 94);
        var milk = await owner.NewProductAsync("Leite");
        var merged = Guid.NewGuid();
        (await BatchAsync(app, ownerToken, Operation("product", merged, new { name = "leite" }))).Single()
            .GetProperty("entityId").GetGuid().Should().Be(milk);
        var before = await owner.ChangesAsync();

        // Outra pessoa, de outro grupo, usa o id juntado: ele não a leva ao leite de ninguém.
        var strangerSession = await app.NewGuestAsync("Estranho", ["module:shopping"], 95);
        var stranger = new ShoppingClient(app, strangerSession.Login.AccessToken);
        var theirs = await ShoppingClient.OkAsync(stranger.WriteAsync(HttpMethod.Put, $"/products/{merged}", new() { ["name"] = "Leite" }));
        theirs.GetProperty("id").GetGuid().Should().Be(merged);
        (await owner.ChangesAsync()).Should().HaveCount(before.Count);

        // Renomear um produto que existe para o nome de outro continua sendo recusa: é escolha de quem renomeia.
        var bread = await owner.NewProductAsync("Pão");
        using var rename = await owner.WriteAsync(HttpMethod.Put, $"/products/{bread}", new() { ["name"] = "LEITE" });
        rename.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task DeletingByAMergedId_NeverDeletesTheRecordThatStayed()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var (owner, _, guest, guestToken) = await TwoMembersAsync(app, 96);
        var milk = await owner.NewProductAsync("Leite");
        var milkItem = await owner.NewListItemAsync(milk, needed: false);
        var purchase = await owner.OpenPurchaseAsync();
        var milkLine = Guid.NewGuid();
        await ShoppingClient.OkAsync(owner.WriteAsync(
            HttpMethod.Put, $"/purchases/{purchase}/items/{milkLine}", new() { ["productId"] = milk, ["quantity"] = 1, ["picked"] = true }));

        // O outro aparelho, sem sinal, criou o leite (o produto, o item, a linha) e apagou logo em seguida. No servidor a
        // criação vira o leite que já existia; o "apagar" que vem atrás, pelo id daqui, não pode apagar o leite de quem tinha.
        var local = (Product: Guid.NewGuid(), Item: Guid.NewGuid(), Line: Guid.NewGuid());
        object[] batch =
        [
            Operation("product", local.Product, new { name = "leite" }),
            Operation("listItem", local.Item, new { productId = local.Product, quantity = 1, needed = true }),
            Operation("purchaseItem", local.Line, new { productId = local.Product, quantity = 1, picked = false }, purchase),
            Operation("purchaseItem", local.Line, new { productId = local.Product, quantity = 1, picked = false, deleted = true }, purchase),
            Operation("listItem", local.Item, new { productId = local.Product, quantity = 1, needed = true, deleted = true }),
            Operation("product", local.Product, new { name = "leite", deleted = true }),
        ];
        var results = await BatchAsync(app, guestToken, batch);
        results.Select(x => x.GetProperty("status").GetInt32()).Should().Equal(200, 200, 200, 204, 204, 204);
        var feed = await guest.ChangesAsync();

        // O lote reenviado (a resposta se perdeu) dá o mesmo desfecho; a rota direta, também.
        (await BatchAsync(app, guestToken, batch)).Select(x => x.GetProperty("status").GetInt32()).Should().Equal(200, 200, 200, 204, 204, 204);
        using (var direct = await guest.WriteAsync(HttpMethod.Put, $"/products/{local.Product}", new() { ["name"] = "leite", ["deleted"] = true }))
        {
            direct.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        (await guest.ChangesAsync()).Should().HaveCount(feed.Count, "apagar a cópia não muda nada no grupo");
        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        var product = await db.Products.AsNoTracking().SingleAsync(Ct);
        (product.Id, product.DeletedAt).Should().Be((milk, (DateTimeOffset?)null));
        var item = await db.ListItems.AsNoTracking().SingleAsync(Ct);
        (item.Id, item.DeletedAt).Should().Be((milkItem, (DateTimeOffset?)null));
        var line = await db.PurchaseItems.AsNoTracking().SingleAsync(Ct);
        (line.Id, line.DeletedAt).Should().Be((milkLine, (DateTimeOffset?)null));

        // Um id juntado de produto só vale para produto: usado como id de linha da compra, não leva à linha do leite.
        using var stray = await guest.WriteAsync(
            HttpMethod.Put, $"/purchases/{purchase}/items/{local.Product}", new() { ["productId"] = milk, ["quantity"] = 1, ["picked"] = false, ["deleted"] = true });
        stray.StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await db.PurchaseItems.AsNoTracking().SingleAsync(Ct)).DeletedAt.Should().BeNull();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ATapAndAPriceFromTwoDevices_EndTheSame_WhicheverArrivesFirst(bool priceFirst)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var (owner, ownerToken, _, guestToken) = await TwoMembersAsync(app, 97);
        var milk = await owner.NewProductAsync("Leite");
        var purchase = await owner.OpenPurchaseAsync();
        var t0 = DateTimeOffset.UtcNow.AddMinutes(-10);
        var t1 = t0.AddMinutes(5);

        // Um aparelho só marcou "peguei" (depois); ele tinha 5 de preço na tela, mas não mexeu nele. O outro só digitou 7.
        var tap = Operation("purchaseItem", Guid.NewGuid(), new { productId = milk, quantity = 1, picked = true, unitPrice = 5, only = "picked" }, purchase, t1);
        var price = Operation("purchaseItem", Guid.NewGuid(), new { productId = milk, quantity = 1, picked = false, unitPrice = 7, only = "price" }, purchase, t0);
        if (priceFirst)
        {
            await BatchAsync(app, guestToken, price);
            await BatchAsync(app, ownerToken, tap);
        }
        else
        {
            await BatchAsync(app, ownerToken, tap);
            await BatchAsync(app, guestToken, price);
        }

        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        var line = await db.PurchaseItems.AsNoTracking().SingleAsync(Ct);
        (line.Picked, line.UnitPrice).Should().Be((true, 7m), "o preço que só um digitou vale, e o toque do outro também");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task APhoneWithItsClockBehind_StillWinsWithTheNewerPrice(bool merged)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var (owner, ownerToken, _, guestToken) = await TwoMembersAsync(app, 98);
        var milk = await owner.NewProductAsync("Leite");
        var purchase = await owner.OpenPurchaseAsync();
        var now = DateTimeOffset.UtcNow;
        var line = Guid.NewGuid();

        // Relógio certo: o preço 5 foi digitado há dez minutos.
        await BatchAsync(
            app,
            ownerToken,
            now,
            Operation("purchaseItem", line, new { productId = milk, quantity = 1, picked = false, unitPrice = 5, only = "price" }, purchase, now.AddMinutes(-10)));

        // O relógio do outro aparelho está uma hora atrasado: o 7 foi digitado há um minuto, mas ele acha que foi há 61.
        var behind = now.AddHours(-1);
        await BatchAsync(
            app,
            guestToken,
            behind,
            Operation("purchaseItem", merged ? Guid.NewGuid() : line, new { productId = milk, quantity = 1, picked = false, unitPrice = 7, only = "price" }, purchase, behind.AddMinutes(-1)));

        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        (await db.PurchaseItems.AsNoTracking().SingleAsync(Ct)).UnitPrice.Should().Be(7m);

        // Um aparelho da versão anterior não diz quando enviou: vale a hora em que chegou, então o preço dele é o mais novo.
        await BatchAsync(
            app,
            guestToken,
            null,
            Operation("purchaseItem", line, new { productId = milk, quantity = 1, picked = false, unitPrice = 9, only = "price" }, purchase, behind.AddDays(-1)));
        (await db.PurchaseItems.AsNoTracking().SingleAsync(Ct)).UnitPrice.Should().Be(9m);
    }

    private static async Task<(ShoppingClient Owner, string OwnerToken, ShoppingClient Guest, string GuestToken)> TwoMembersAsync(TrainingApp app, int seed)
    {
        var ownerLogin = await app.LoginAsync();
        var owner = new ShoppingClient(app, ownerLogin.AccessToken);
        var guestSession = await app.NewGuestAsync("Convidada", ["module:shopping"], seed);
        var guest = new ShoppingClient(app, guestSession.Login.AccessToken);
        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/group/members/{guestSession.UserId}", []));
        (await guest.GroupIdAsync()).Should().Be(await owner.GroupIdAsync());
        return (owner, ownerLogin.AccessToken, guest, guestSession.Login.AccessToken);
    }

    private static object Operation(string kind, Guid id, object body, Guid? purchaseId = null, DateTimeOffset? at = null) =>
        new { operationId = Guid.NewGuid(), kind, id, purchaseId, body, at };

    /// <summary>Um lote enviado agora, por um aparelho com o relógio certo.</summary>
    private static Task<List<JsonElement>> BatchAsync(TrainingApp app, string token, params object[] operations) =>
        BatchAsync(app, token, DateTimeOffset.UtcNow, operations);

    /// <param name="sentAt">A hora do envio no relógio do aparelho; <c>null</c> é o aparelho que não a manda.</param>
    private static async Task<List<JsonElement>> BatchAsync(TrainingApp app, string token, DateTimeOffset? sentAt, params object[] operations)
    {
        object body = sentAt is null ? new { operations } : new { operations, sentAt };
        using var response = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/operations", body, token);
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return [.. (await TrainingApp.JsonAsync(response)).EnumerateArray()];
    }
}
