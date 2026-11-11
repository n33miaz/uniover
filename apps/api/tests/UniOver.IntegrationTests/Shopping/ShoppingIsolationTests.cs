using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training;

namespace UniOver.IntegrationTests.Shopping;

/// <summary>
/// Duas pessoas, cada uma no próprio grupo. A prova é por rota: com o id de um registro da outra, ninguém lê, altera,
/// apaga nem recebe pista dele; e reenviar uma operação própria apontando para o id alheio também não entrega nada.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class ShoppingIsolationTests(PostgresFixture postgres)
{
    private static readonly string[] Shopping = ["module:shopping"];
    private static readonly string[] TrainingOnly = ["module:training"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed record Data(Guid Product, Guid ListItem, Guid Purchase, Guid Line);

    private static async Task<Data> SeedAsync(ShoppingClient client, string secret)
    {
        var product = await client.NewProductAsync(secret);
        var listItem = await client.NewListItemAsync(product, note: secret);
        var purchase = await client.OpenPurchaseAsync(budget: 50);
        var line = (await client.ChangesAsync())
            .Single(x => x.GetProperty("entityType").GetString() == "purchaseItem")
            .GetProperty("entityId").GetGuid();
        return new Data(product, listItem, purchase, line);
    }

    [Fact]
    public async Task AMemberOfAnotherGroup_NeitherReadsNorWrites_AnyRecordOfThisGroup()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var aliceSession = await app.NewGuestAsync("Alice", Shopping, 91);
        var brunoSession = await app.NewGuestAsync("Bruno", Shopping, 92);
        var alice = new ShoppingClient(app, aliceSession.Login.AccessToken);
        var bruno = new ShoppingClient(app, brunoSession.Login.AccessToken);
        var a = await SeedAsync(alice, "segredo-da-alice");
        var b = await SeedAsync(bruno, "segredo-do-bruno");
        (await alice.GroupIdAsync()).Should().NotBe(await bruno.GroupIdAsync());

        // Leituras: nada da Alice aparece para o Bruno, qualquer que seja o cursor.
        foreach (var path in new[] { "/changes?after=0", "/purchases", "/group/members", "/group" })
        {
            using var response = await bruno.GetAsync(path);
            response.StatusCode.Should().Be(HttpStatusCode.OK);
            var text = await response.Content.ReadAsStringAsync(Ct);
            text.Should().NotContain("segredo-da-alice", path);
            text.Should().NotContain(a.Purchase.ToString(), path);
            text.Should().NotContain(aliceSession.UserId.ToString(), path);
        }

        using (var price = await bruno.GetAsync($"/products/{a.Product}/last-price"))
        {
            price.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        // Escritas com o id alheio: recusadas, sem o conteúdo da Alice na resposta.
        var attempts = new (HttpMethod Method, string Path, Dictionary<string, object?> Body)[]
        {
            (HttpMethod.Put, $"/products/{a.Product}", new() { ["name"] = "Tomado" }),
            (HttpMethod.Put, $"/products/{a.Product}", new() { ["deleted"] = true }),
            (HttpMethod.Put, $"/list-items/{a.ListItem}", new() { ["productId"] = b.Product, ["quantity"] = 9, ["needed"] = false }),
            (HttpMethod.Put, $"/list-items/{a.ListItem}", new() { ["deleted"] = true }),
            (HttpMethod.Put, $"/list-items/{Guid.NewGuid()}", new() { ["productId"] = a.Product, ["quantity"] = 1, ["needed"] = true }),
            (HttpMethod.Post, $"/purchases/{a.Purchase}/open", new() { ["budget"] = 1 }),
            (HttpMethod.Put, $"/purchases/{a.Purchase}/budget", new() { ["budget"] = 1 }),
            (HttpMethod.Post, $"/purchases/{a.Purchase}/close", new() { ["totalPaid"] = 1 }),
            (HttpMethod.Put, $"/purchases/{a.Purchase}/items/{a.Line}", new() { ["productId"] = a.Product, ["quantity"] = 5, ["picked"] = true }),
            (HttpMethod.Put, $"/purchases/{a.Purchase}/items/{a.Line}", new() { ["deleted"] = true }),
            (HttpMethod.Put, $"/purchases/{b.Purchase}/items/{a.Line}", new() { ["productId"] = b.Product, ["quantity"] = 5, ["picked"] = true }),
            (HttpMethod.Put, $"/purchases/{b.Purchase}/items/{Guid.NewGuid()}", new() { ["productId"] = a.Product, ["quantity"] = 1, ["picked"] = true }),
            (HttpMethod.Put, $"/group/members/{aliceSession.UserId}", new() { ["deleted"] = true }),
        };
        foreach (var (method, path, body) in attempts)
        {
            using var response = await bruno.WriteAsync(method, path, body);
            ((int)response.StatusCode).Should().BeOneOf([400, 404, 409], $"{method} {path}");
            (await response.Content.ReadAsStringAsync(Ct)).Should().NotContain("segredo-da-alice", $"{method} {path}");
        }

        // Reenvio de uma operação do próprio Bruno, agora apontando para os ids da Alice: o "replay" lê só o grupo dele.
        var operation = Guid.NewGuid();
        await ShoppingClient.OkAsync(bruno.WriteAsync(HttpMethod.Put, $"/products/{Guid.NewGuid()}", new() { ["name"] = "Isca" }, operation));
        foreach (var (method, path) in new[]
        {
            (HttpMethod.Put, $"/products/{a.Product}"),
            (HttpMethod.Put, $"/list-items/{a.ListItem}"),
            (HttpMethod.Put, $"/purchases/{a.Purchase}/budget"),
            (HttpMethod.Post, $"/purchases/{a.Purchase}/close"),
            (HttpMethod.Post, $"/purchases/{a.Purchase}/open"),
            (HttpMethod.Put, $"/purchases/{a.Purchase}/items/{a.Line}"),
        })
        {
            using var response = await bruno.WriteAsync(
                method, path, new() { ["name"] = "x", ["productId"] = a.Product, ["quantity"] = 1, ["needed"] = true, ["picked"] = true, ["totalPaid"] = 1 }, operation);
            response.StatusCode.Should().Be(HttpStatusCode.NotFound, $"replay {method} {path}");
            (await response.Content.ReadAsStringAsync(Ct)).Should().NotContain("segredo-da-alice");
        }

        // E uma operação da Alice não serve ao Bruno: o UUID dela é recusado sem aplicar nada.
        var hers = Guid.NewGuid();
        await ShoppingClient.OkAsync(alice.WriteAsync(HttpMethod.Put, $"/products/{Guid.NewGuid()}", new() { ["name"] = "Dela" }, hers));
        using (var stolen = await bruno.WriteAsync(HttpMethod.Put, $"/products/{Guid.NewGuid()}", new() { ["name"] = "Dele" }, hers))
        {
            stolen.StatusCode.Should().Be(HttpStatusCode.Conflict);
        }

        // O que é da Alice ficou como estava.
        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        var product = await db.Products.AsNoTracking().SingleAsync(x => x.Id == a.Product, Ct);
        product.Name.Should().Be("segredo-da-alice");
        product.DeletedAt.Should().BeNull();
        var listItem = await db.ListItems.AsNoTracking().SingleAsync(x => x.Id == a.ListItem, Ct);
        listItem.DeletedAt.Should().BeNull();
        listItem.ProductId.Should().Be(a.Product);
        var purchase = await db.Purchases.AsNoTracking().SingleAsync(x => x.Id == a.Purchase, Ct);
        purchase.Status.Should().Be("open");
        purchase.Budget.Should().Be(50m);
        var line = await db.PurchaseItems.AsNoTracking().SingleAsync(x => x.Id == a.Line, Ct);
        line.DeletedAt.Should().BeNull();
        line.Picked.Should().BeFalse();
        (await db.Products.AsNoTracking().CountAsync(x => x.GroupId == product.GroupId, Ct)).Should().Be(2, "o produto da Alice e o 'Dela'");
    }

    [Fact]
    public async Task EveryRoute_RequiresTheModulePermission()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var outsider = new ShoppingClient(app, (await app.NewGuestAsync("Sem compras", TrainingOnly, 97)).Login.AccessToken);
        var id = Guid.NewGuid();

        foreach (var path in new[] { "/group", "/group/members", "/changes", "/purchases", $"/products/{id}/last-price" })
        {
            using var response = await outsider.GetAsync(path);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, path);
        }

        foreach (var (method, path) in new[]
        {
            (HttpMethod.Put, $"/group/members/{id}"),
            (HttpMethod.Put, $"/products/{id}"),
            (HttpMethod.Put, $"/list-items/{id}"),
            (HttpMethod.Post, $"/purchases/{id}/open"),
            (HttpMethod.Put, $"/purchases/{id}/budget"),
            (HttpMethod.Post, $"/purchases/{id}/close"),
            (HttpMethod.Put, $"/purchases/{id}/items/{id}"),
        })
        {
            using var response = await outsider.WriteAsync(method, path, new() { ["name"] = "x" });
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"{method} {path}");
        }

        using var anonymous = await app.SendAsync(HttpMethod.Get, ShoppingClient.Base + "/group");
        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        (await db.Groups.CountAsync(Ct)).Should().Be(0, "quem não tem a permissão não chega a ganhar um grupo");
    }

    [Fact]
    public async Task OnlyTheGroupOwner_ManagesMembers_AndARemovedMemberLosesTheGroup()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var ownerLogin = await app.LoginAsync();
        var owner = new ShoppingClient(app, ownerLogin.AccessToken);
        var guestSession = await app.NewGuestAsync("Convidada", Shopping, 93);
        var guest = new ShoppingClient(app, guestSession.Login.AccessToken);
        var outsiderSession = await app.NewGuestAsync("Só treino", TrainingOnly, 94);
        var busySession = await app.NewGuestAsync("Com lista própria", Shopping, 95);
        var busy = new ShoppingClient(app, busySession.Login.AccessToken);
        var groupId = await owner.GroupIdAsync();
        var milk = await owner.NewProductAsync("Leite");

        // Quem já abriu o módulo e tem o grupo próprio vazio entra; quem tem conteúdo no próprio grupo não é arrancado dele.
        await guest.GroupIdAsync();
        await busy.NewProductAsync("Meu produto");
        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/group/members/{guestSession.UserId}", []));
        using (var refused = await owner.WriteAsync(HttpMethod.Put, $"/group/members/{busySession.UserId}", []))
        {
            refused.StatusCode.Should().Be(HttpStatusCode.Conflict);
        }

        using (var noPermission = await owner.WriteAsync(HttpMethod.Put, $"/group/members/{outsiderSession.UserId}", []))
        {
            noPermission.StatusCode.Should().Be(HttpStatusCode.BadRequest, "quem entra precisa da permissão do módulo");
        }

        // A convidada enxerga o grupo (feed inteiro desde o zero) e escreve nele, mas não gerencia pessoas.
        (await guest.GroupIdAsync()).Should().Be(groupId);
        (await guest.ChangesAsync()).Should().Contain(x => x.GetProperty("entityId").GetGuid() == milk);
        await guest.NewListItemAsync(milk);
        using (var forbidden = await guest.WriteAsync(HttpMethod.Put, $"/group/members/{busySession.UserId}", []))
        {
            forbidden.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }

        using (var selfRemoval = await owner.WriteAsync(
            HttpMethod.Put, $"/group/members/{TrainingApp.UserIdOf(ownerLogin)}", new() { ["deleted"] = true }))
        {
            selfRemoval.StatusCode.Should().Be(HttpStatusCode.BadRequest, "quem criou o grupo não sai dele");
        }

        // Removida, ela cai num grupo novo e vazio: nada do grupo antigo continua ao alcance.
        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/group/members/{guestSession.UserId}", new() { ["deleted"] = true }));
        (await guest.GroupIdAsync()).Should().NotBe(groupId);
        (await guest.ChangesAsync()).Should().BeEmpty();
        using (var gone = await guest.WriteAsync(HttpMethod.Put, $"/products/{milk}", new() { ["name"] = "Leite alterado" }))
        {
            gone.StatusCode.Should().Be(HttpStatusCode.Conflict, "o id pertence a um grupo que não é mais o dela");
        }

        var members = await ShoppingClient.OkAsync(owner.GetAsync("/group/members"));
        members.EnumerateArray().Single(x => x.GetProperty("userId").GetGuid() == guestSession.UserId)
            .GetProperty("deleted").GetBoolean().Should().BeTrue();
    }
}
