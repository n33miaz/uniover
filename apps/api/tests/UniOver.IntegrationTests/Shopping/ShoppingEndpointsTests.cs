using System.Text.Json;
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
        var login = await app.LoginAsync();
        var owner = new ShoppingClient(app, login.AccessToken);

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

        // O mesmo nome criado de novo (outro aparelho, sem sinal) não vira um segundo produto: a resposta é o que já existe.
        var again = await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/products/{Guid.NewGuid()}", new() { ["name"] = " acucar " }));
        again.GetProperty("id").GetGuid().Should().Be(sugar);
        again.GetProperty("name").GetString().Should().Be("Açúcar");

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

    [Fact]
    public async Task OneGroup_HasOnlyOneOpenPurchase_AndClosingItClearsPickedListItems()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var milk = await owner.NewProductAsync("Leite");
        var bread = await owner.NewProductAsync("Pão");
        var milkItem = await owner.NewListItemAsync(milk);
        var breadItem = await owner.NewListItemAsync(bread);
        var first = await owner.OpenPurchaseAsync();

        using (var second = await owner.WriteAsync(HttpMethod.Post, $"/purchases/{Guid.NewGuid()}/open", []))
        {
            second.StatusCode.Should().Be(HttpStatusCode.Conflict);
            // O corpo só pode ser lido uma vez: o tipo e o id da compra aberta saem da mesma leitura.
            var problem = await TrainingApp.JsonAsync(second);
            problem.GetProperty("type").GetString().Should().EndWith("shopping-purchase-already-open");
            problem.GetProperty("openPurchaseId").GetGuid().Should().Be(first);
        }

        // Só o leite é pego: ao fechar, ele sai do "precisa"; o pão, que ficou na prateleira, continua na lista.
        var milkLine = (await owner.ChangesAsync())
            .Single(x => x.GetProperty("entityType").GetString() == "purchaseItem" && x.GetProperty("payload").GetProperty("productId").GetGuid() == milk)
            .GetProperty("entityId").GetGuid();
        await ShoppingClient.OkAsync(owner.WriteAsync(
            HttpMethod.Put, $"/purchases/{first}/items/{milkLine}", new() { ["productId"] = milk, ["quantity"] = 1, ["picked"] = true }));
        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Post, $"/purchases/{first}/close", new() { ["totalPaid"] = 1m }));

        var changes = await owner.ChangesAsync();
        changes.Last(x => x.GetProperty("entityId").GetGuid() == milkItem).GetProperty("payload").GetProperty("needed").GetBoolean().Should().BeFalse();
        changes.Last(x => x.GetProperty("entityId").GetGuid() == breadItem).GetProperty("payload").GetProperty("needed").GetBoolean().Should().BeTrue();

        // Fechada a primeira, a próxima compra abre normalmente.
        await owner.OpenPurchaseAsync();
    }

    private static object Operation(string kind, Guid id, object? body, Guid? operationId = null, Guid? purchaseId = null) =>
        new { operationId = operationId ?? Guid.NewGuid(), kind, id, purchaseId, body };

    private static async Task<List<JsonElement>> BatchAsync(TrainingApp app, string token, params object[] operations)
    {
        using var response = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/operations", new { operations }, token);
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return [.. (await TrainingApp.JsonAsync(response)).EnumerateArray()];
    }

    [Fact]
    public async Task OperationsBatch_AppliesInOrder_ReportsEachOutcome_AndARefusalDoesNotStopTheRest()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var owner = new ShoppingClient(app, login.AccessToken);
        var rice = Guid.NewGuid();
        var beans = Guid.NewGuid();
        var listItem = Guid.NewGuid();
        var purchase = Guid.NewGuid();
        object[] batch =
        [
            Operation("product", rice, new { name = "Arroz" }),
            Operation("listItem", listItem, new { productId = rice, quantity = 2, needed = true }),
            Operation("product", Guid.NewGuid(), new { name = "" }),
            Operation("unknown", Guid.NewGuid(), new { }),
            Operation("purchaseItem", Guid.NewGuid(), new { productId = rice, quantity = 1, picked = true }),
            Operation("product", beans, new { name = "Feijão", operationId = Guid.NewGuid() }),
            Operation("openPurchase", purchase, new { }),
            Operation("openPurchase", Guid.NewGuid(), new { budget = 10 }),
            Operation("product", Guid.NewGuid(), "texto"),
        ];

        var results = await BatchAsync(app, login.AccessToken, batch);

        results.Select(x => x.GetProperty("status").GetInt32()).Should().Equal(200, 200, 400, 400, 400, 200, 200, 409, 400);
        results.Select(x => x.GetProperty("operationId").GetGuid()).Should().Equal(
            batch.Select(x => (Guid)x.GetType().GetProperty("operationId")!.GetValue(x)!), "cada desfecho leva o UUID da sua operação, na ordem do envio");
        results[7].GetProperty("type").GetString().Should().EndWith("shopping-purchase-already-open");
        results[7].GetProperty("openPurchaseId").GetGuid().Should().Be(purchase);
        results[0].GetProperty("type").ValueKind.Should().Be(JsonValueKind.Null);

        var changes = await owner.ChangesAsync();
        changes.Select(x => x.GetProperty("entityId").GetGuid()).Take(4).Should().Equal(rice, listItem, beans, purchase);

        // O mesmo lote de novo (a resposta se perdeu): nada é aplicado duas vezes e o feed não cresce.
        var again = await BatchAsync(app, login.AccessToken, batch);
        again.Select(x => x.GetProperty("status").GetInt32()).Should().Equal(200, 200, 400, 400, 400, 200, 200, 409, 400);
        (await owner.ChangesAsync()).Should().HaveCount(changes.Count);
    }

    [Fact]
    public async Task OperationsBatch_AcceptsFromOneToFiftyOperations()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        foreach (var count in new[] { 0, 51 })
        {
            var operations = Enumerable.Range(0, count).Select(i => Operation("product", Guid.NewGuid(), new { name = $"Produto {i}" })).ToArray();
            using var refused = await app.SendAsync(HttpMethod.Post, ShoppingClient.Base + "/operations", new { operations }, login.AccessToken);
            refused.StatusCode.Should().Be(HttpStatusCode.BadRequest, $"{count} operações");
        }

        using (var noUuid = await app.SendAsync(
            HttpMethod.Post, ShoppingClient.Base + "/operations", new { operations = new[] { Operation("product", Guid.NewGuid(), new { name = "x" }, Guid.Empty) } }, login.AccessToken))
        {
            noUuid.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        var full = Enumerable.Range(0, 50).Select(i => Operation("product", Guid.NewGuid(), new { name = $"Produto {i}" })).ToArray();
        (await BatchAsync(app, login.AccessToken, full)).Should().OnlyContain(x => x.GetProperty("status").GetInt32() == 200);
        (await new ShoppingClient(app, login.AccessToken).ChangesAsync()).Should().HaveCount(50);
    }

    [Fact]
    public async Task OperationsBatch_NeverReachesAnotherGroup()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var aliceSession = await app.NewGuestAsync("Alice", ["module:shopping"], 81);
        var brunoSession = await app.NewGuestAsync("Bruno", ["module:shopping"], 82);
        var alice = new ShoppingClient(app, aliceSession.Login.AccessToken);
        var bruno = new ShoppingClient(app, brunoSession.Login.AccessToken);
        var product = await alice.NewProductAsync("segredo-da-alice");
        var listItem = await alice.NewListItemAsync(product);
        var purchase = await alice.OpenPurchaseAsync();
        var line = (await alice.ChangesAsync()).Single(x => x.GetProperty("entityType").GetString() == "purchaseItem").GetProperty("entityId").GetGuid();
        var before = await alice.ChangesAsync();

        var results = await BatchAsync(
            app,
            brunoSession.Login.AccessToken,
            Operation("product", product, new { name = "Tomado" }),
            Operation("listItem", listItem, new { productId = product, quantity = 9, needed = false }),
            Operation("listItem", Guid.NewGuid(), new { productId = product, quantity = 1, needed = true }),
            Operation("budget", purchase, new { budget = 1 }),
            Operation("closePurchase", purchase, new { totalPaid = 1 }),
            Operation("purchaseItem", line, new { productId = product, quantity = 1, picked = true }, purchaseId: purchase),
            Operation("openPurchase", purchase, new { }),
            Operation("member", aliceSession.UserId, new { deleted = true }),
            Operation("product", Guid.NewGuid(), new { name = "Do Bruno" }));

        results.Take(8).Should().OnlyContain(x => x.GetProperty("status").GetInt32() >= 400, "nenhuma operação alcança o grupo da Alice");
        results[8].GetProperty("status").GetInt32().Should().Be(200);
        (await alice.ChangesAsync()).Should().HaveCount(before.Count, "o grupo da Alice não mudou");
        (await bruno.ChangesAsync()).Should().ContainSingle().Which.GetProperty("payload").GetProperty("name").GetString().Should().Be("Do Bruno");

        // Uma operação da Alice reenviada pelo Bruno também não entrega nada dela.
        var aliceOperation = before[0].GetProperty("operationId").GetGuid();
        var replay = await BatchAsync(app, brunoSession.Login.AccessToken, Operation("product", product, new { name = "x" }, aliceOperation));
        replay.Single().GetProperty("status").GetInt32().Should().Be(409);
    }

    [Fact]
    public async Task AMember_LeavesTheGroup_GetsAnEmptyOne_AndTheTrailRecordsWhoCameAndWent()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var ownerLogin = await app.LoginAsync();
        var ownerId = TrainingApp.UserIdOf(ownerLogin);
        var owner = new ShoppingClient(app, ownerLogin.AccessToken);
        var guestSession = await app.NewGuestAsync("Convidada", ["module:shopping"], 83);
        var guest = new ShoppingClient(app, guestSession.Login.AccessToken);
        var groupId = await owner.GroupIdAsync();
        await owner.NewProductAsync("Leite");

        using (var ownerLeaves = await owner.WriteAsync(HttpMethod.Post, "/group/leave", []))
        {
            ownerLeaves.StatusCode.Should().Be(HttpStatusCode.BadRequest, "quem criou o grupo não sai dele");
        }

        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/group/members/{guestSession.UserId}", []));
        (await guest.GroupIdAsync()).Should().Be(groupId);

        var operation = Guid.NewGuid();
        var left = await ShoppingClient.OkAsync(guest.WriteAsync(HttpMethod.Post, "/group/leave", [], operation));
        var own = left.GetProperty("id").GetGuid();
        own.Should().NotBe(groupId);
        left.GetProperty("isOwner").GetBoolean().Should().BeTrue();

        // O reenvio (a resposta se perdeu) devolve o mesmo grupo novo, sem sair de novo nem criar outro.
        var replay = await ShoppingClient.OkAsync(guest.WriteAsync(HttpMethod.Post, "/group/leave", [], operation));
        replay.GetProperty("id").GetGuid().Should().Be(own);
        (await guest.GroupIdAsync()).Should().Be(own);
        (await guest.ChangesAsync()).Should().BeEmpty("o grupo novo começa vazio e nada do antigo vem junto");

        var members = await ShoppingClient.OkAsync(owner.GetAsync("/group/members"));
        members.EnumerateArray().Single(x => x.GetProperty("userId").GetGuid() == guestSession.UserId).GetProperty("deleted").GetBoolean().Should().BeTrue();

        // Entrar de novo e ser retirada pelo dono: o grupo próprio (vazio) é deixado, e a retirada devolve outro.
        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/group/members/{guestSession.UserId}", []));
        await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Put, $"/group/members/{guestSession.UserId}", new() { ["deleted"] = true }));
        (await guest.GroupIdAsync()).Should().NotBe(groupId);

        // A trilha guarda só a gestão de pessoas: duas entradas e duas saídas, nada dos toques de lista.
        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        var trail = await db.MemberAudit.AsNoTracking().OrderBy(x => x.OccurredAt).ThenBy(x => x.Id).ToListAsync(Ct);
        trail.Select(x => (x.Event, x.ActorUserId, x.TargetUserId)).Should().Equal(
            ("member_added", ownerId, guestSession.UserId),
            ("member_removed", guestSession.UserId, guestSession.UserId),
            ("member_added", ownerId, guestSession.UserId),
            ("member_removed", ownerId, guestSession.UserId));
        (await db.Members.CountAsync(x => x.UserId == guestSession.UserId && x.DeletedAt == null, Ct)).Should().Be(1, "uma participação viva por conta");
    }
}
