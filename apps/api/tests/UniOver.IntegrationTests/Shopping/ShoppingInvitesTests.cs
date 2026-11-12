using System.Net;
using System.Security.Cryptography;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training;

namespace UniOver.IntegrationTests.Shopping;

/// <summary>
/// Os convites do grupo por link ou QR, a compra começada do zero, a promoção na linha e a categoria dada pelo nome.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class ShoppingInvitesTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<string> NewInviteAsync(ShoppingClient owner)
    {
        var created = await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Post, "/group/invites", []));
        return created.GetProperty("token").GetString()!;
    }

    [Fact]
    public async Task AnInvite_PutsThePersonInTheOwnersGroup_OnceOnly_AndOnlyTheHashIsStored()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var ownerLogin = await app.LoginAsync();
        var ownerId = TrainingApp.UserIdOf(ownerLogin);
        var owner = new ShoppingClient(app, ownerLogin.AccessToken);
        var alice = await app.NewGuestAsync("Alice", ["module:shopping"], 91);
        var bruno = await app.NewGuestAsync("Bruno", ["module:shopping"], 92);
        var aliceClient = new ShoppingClient(app, alice.Login.AccessToken);
        var brunoClient = new ShoppingClient(app, bruno.Login.AccessToken);
        var groupId = await owner.GroupIdAsync();
        await owner.NewProductAsync("Leite");

        var token = await NewInviteAsync(owner);

        var joined = await ShoppingClient.OkAsync(aliceClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = token }));
        joined.GetProperty("id").GetGuid().Should().Be(groupId);
        joined.GetProperty("isOwner").GetBoolean().Should().BeFalse();
        (await aliceClient.GroupIdAsync()).Should().Be(groupId);
        (await aliceClient.ChangesAsync()).Should().Contain(x => x.GetProperty("entityType").GetString() == "product", "quem entra vê a lista do grupo");

        // Abrir o mesmo link de novo não faz mal; outra pessoa com o link já usado não entra.
        await ShoppingClient.OkAsync(aliceClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = token }));
        using (var reused = await brunoClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = token }))
        {
            reused.StatusCode.Should().Be(HttpStatusCode.Gone);
        }

        (await brunoClient.GroupIdAsync()).Should().NotBe(groupId);
        (await owner.ChangesAsync()).Should().Contain(x =>
            x.GetProperty("entityType").GetString() == "member" && x.GetProperty("entityId").GetGuid() == alice.UserId);

        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        var stored = await db.GroupInvites.AsNoTracking().SingleAsync(Ct);
        stored.TokenHash.Should().Equal(SHA256.HashData(Convert.FromBase64String(token.Replace('-', '+').Replace('_', '/') + "=")));
        stored.UsedBy.Should().Be(alice.UserId);
        var trail = await db.MemberAudit.AsNoTracking().OrderBy(x => x.OccurredAt).ThenBy(x => x.Id).ToListAsync(Ct);
        trail.Select(x => (x.Event, x.ActorUserId)).Should().Equal(("invite_created", ownerId), ("member_joined", alice.UserId));
    }

    [Fact]
    public async Task OnlyTheOwner_CreatesListsAndRevokesInvites_AndARevokedOrUnknownInviteIsGone()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var alice = await app.NewGuestAsync("Alice", ["module:shopping"], 93);
        var aliceClient = new ShoppingClient(app, alice.Login.AccessToken);
        await owner.GroupIdAsync();

        var token = await NewInviteAsync(owner);
        var pending = await ShoppingClient.OkAsync(owner.GetAsync("/group/invites"));
        pending.GetArrayLength().Should().Be(1);
        pending[0].TryGetProperty("token", out _).Should().BeFalse("o segredo só existe na criação");
        var id = pending[0].GetProperty("id").GetGuid();

        // Alice é dona do grupo dela, mas não do grupo do convite: não vê nem cancela os convites de outro grupo.
        using (var foreign = await aliceClient.WriteAsync(HttpMethod.Post, $"/group/invites/{id}/revoke", []))
        {
            foreign.StatusCode.Should().Be(HttpStatusCode.NotFound);
        }

        using (var revoked = await owner.WriteAsync(HttpMethod.Post, $"/group/invites/{id}/revoke", []))
        {
            revoked.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        (await ShoppingClient.OkAsync(owner.GetAsync("/group/invites"))).GetArrayLength().Should().Be(0);
        using (var late = await aliceClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = token }))
        {
            late.StatusCode.Should().Be(HttpStatusCode.Gone);
        }

        using (var garbage = await aliceClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = "nada" }))
        {
            garbage.StatusCode.Should().Be(HttpStatusCode.Gone);
        }

        // Quem entrou como membro não convida ninguém.
        await ShoppingClient.OkAsync(aliceClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = await NewInviteAsync(owner) }));
        using (var member = await aliceClient.WriteAsync(HttpMethod.Post, "/group/invites", []))
        {
            member.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }
    }

    [Fact]
    public async Task APersonWithTheirOwnFullList_IsRefused_AndTheInviteStaysValid()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var alice = await app.NewGuestAsync("Alice", ["module:shopping"], 94);
        var aliceClient = new ShoppingClient(app, alice.Login.AccessToken);
        var ownGroup = await aliceClient.GroupIdAsync();
        var product = await aliceClient.NewProductAsync("Café");
        var token = await NewInviteAsync(owner);

        using (var refused = await aliceClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = token }))
        {
            refused.StatusCode.Should().Be(HttpStatusCode.Conflict);
            (await refused.Content.ReadAsStringAsync(Ct)).Should().Contain("shopping-member-in-another-group");
        }

        (await aliceClient.GroupIdAsync()).Should().Be(ownGroup);

        // Esvaziada a lista dela, o mesmo convite ainda vale.
        await ShoppingClient.OkAsync(aliceClient.WriteAsync(HttpMethod.Put, $"/products/{product}", new() { ["deleted"] = true }));
        await using (var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection))
        {
            (await db.GroupInvites.AsNoTracking().SingleAsync(Ct)).UsedAt.Should().BeNull();
        }
    }

    [Fact]
    public async Task AnAccountWithoutTheShoppingPermission_CannotAccept()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var tvOnly = await app.NewGuestAsync("Só TV", ["module:tv"], 95);
        var token = await NewInviteAsync(owner);

        using var denied = await new ShoppingClient(app, tvOnly.Login.AccessToken)
            .WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = token });
        denied.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task APurchaseFromScratch_LeavesTheListOut()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        await owner.NewListItemAsync(await owner.NewProductAsync("Café"));

        var id = Guid.NewGuid();
        var opened = await ShoppingClient.OkAsync(owner.WriteAsync(HttpMethod.Post, $"/purchases/{id}/open", new() { ["fromList"] = false }));

        opened.GetProperty("fromList").GetBoolean().Should().BeFalse();
        (await owner.ChangesAsync()).Should().NotContain(x => x.GetProperty("entityType").GetString() == "purchaseItem");
        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        (await db.Purchases.AsNoTracking().SingleAsync(Ct)).FromList.Should().BeFalse();
    }

    [Fact]
    public async Task ThePromotion_TravelsWithThePrice_AndGoesAwayWithIt()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var milk = await owner.NewProductAsync("Leite");
        var purchase = await owner.OpenPurchaseAsync();
        var line = Guid.NewGuid();

        var priced = await ShoppingClient.OkAsync(owner.WriteAsync(
            HttpMethod.Put,
            $"/purchases/{purchase}/items/{line}",
            new() { ["productId"] = milk, ["quantity"] = 3, ["unitPrice"] = 3.33m, ["regularPrice"] = 4.99m, ["promoNote"] = " leve 3 pague 2 ", ["picked"] = true }));
        priced.GetProperty("regularPrice").GetDecimal().Should().Be(4.99m);
        priced.GetProperty("promoNote").GetString().Should().Be("leve 3 pague 2");

        // O toque em "peguei" não mexe na promoção.
        var picked = await ShoppingClient.OkAsync(owner.WriteAsync(
            HttpMethod.Put,
            $"/purchases/{purchase}/items/{line}",
            new() { ["productId"] = milk, ["quantity"] = 3, ["picked"] = false, ["only"] = "picked" }));
        picked.GetProperty("promoNote").GetString().Should().Be("leve 3 pague 2");

        var cleared = await ShoppingClient.OkAsync(owner.WriteAsync(
            HttpMethod.Put,
            $"/purchases/{purchase}/items/{line}",
            new() { ["productId"] = milk, ["quantity"] = 3, ["unitPrice"] = null, ["regularPrice"] = null, ["picked"] = false, ["only"] = "price" }));
        cleared.GetProperty("regularPrice").ValueKind.Should().Be(System.Text.Json.JsonValueKind.Null, "sem preço, sem promoção");
        cleared.GetProperty("promoNote").ValueKind.Should().Be(System.Text.Json.JsonValueKind.Null);

        using var tooLong = await owner.WriteAsync(
            HttpMethod.Put,
            $"/purchases/{purchase}/items/{line}",
            new() { ["productId"] = milk, ["quantity"] = 1, ["unitPrice"] = 1m, ["promoNote"] = new string('x', 41), ["picked"] = true });
        tooLong.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Theory]
    [InlineData(null, 4.99)]
    [InlineData(4.99, 4.99)]
    [InlineData(5.49, 4.99)]
    public async Task ARegularPrice_WithoutAPaidPriceOrNotAboveIt_IsRefused(double? unitPrice, double regularPrice)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var milk = await owner.NewProductAsync("Leite");
        var purchase = await owner.OpenPurchaseAsync();
        var line = Guid.NewGuid();

        foreach (var only in new string?[] { null, "price" })
        {
            using var refused = await owner.WriteAsync(
                HttpMethod.Put,
                $"/purchases/{purchase}/items/{line}",
                new() { ["productId"] = milk, ["quantity"] = 1, ["unitPrice"] = (decimal?)unitPrice, ["regularPrice"] = (decimal)regularPrice, ["picked"] = true, ["only"] = only });
            refused.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            (await refused.Content.ReadAsStringAsync(Ct)).Should().Contain("regularPrice");
        }

        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        (await db.PurchaseItems.AsNoTracking().AnyAsync(Ct)).Should().BeFalse("nada recusado fica gravado");
    }

    [Fact]
    public async Task AnOwnerWhoLeavesTheirEmptyGroup_CancelsItsPendingInvites()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        var alice = await app.NewGuestAsync("Alice", ["module:shopping"], 96);
        var bruno = await app.NewGuestAsync("Bruno", ["module:shopping"], 97);
        var aliceClient = new ShoppingClient(app, alice.Login.AccessToken);
        var brunoClient = new ShoppingClient(app, bruno.Login.AccessToken);
        var aliceGroup = await aliceClient.GroupIdAsync();
        var aliceToken = await NewInviteAsync(aliceClient);

        // Alice entra no grupo do dono pelo convite dele e deixa o próprio grupo, vazio.
        await ShoppingClient.OkAsync(aliceClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = await NewInviteAsync(owner) }));

        using (var late = await brunoClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = aliceToken }))
        {
            late.StatusCode.Should().Be(HttpStatusCode.Gone);
        }

        (await brunoClient.GroupIdAsync()).Should().NotBe(aliceGroup);
        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        (await db.GroupInvites.AsNoTracking().SingleAsync(x => x.GroupId == aliceGroup, Ct)).RevokedAt.Should().NotBeNull();
    }

    [Fact]
    public async Task AnInviteToAGroupWhoseOwnerIsGone_IsRefused_AndStaysUnused()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var alice = await app.NewGuestAsync("Alice", ["module:shopping"], 98);
        var bruno = await app.NewGuestAsync("Bruno", ["module:shopping"], 99);
        var aliceClient = new ShoppingClient(app, alice.Login.AccessToken);
        var brunoClient = new ShoppingClient(app, bruno.Login.AccessToken);
        var aliceGroup = await aliceClient.GroupIdAsync();
        var token = await NewInviteAsync(aliceClient);

        // Um convite que escapou do cancelamento (gravado antes da regra, por exemplo): a aceitação confere o dono.
        await using (var conn = new NpgsqlConnection(app.Database.OwnerConnection))
        {
            await conn.OpenAsync(Ct);
            await using var command = new NpgsqlCommand(
                "UPDATE shopping.members SET deleted_at = now() WHERE group_id = @group AND user_id = @user", conn);
            command.Parameters.AddWithValue("group", aliceGroup);
            command.Parameters.AddWithValue("user", alice.UserId);
            (await command.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        }

        using (var refused = await brunoClient.WriteAsync(HttpMethod.Post, "/group/invites/accept", new() { ["token"] = token }))
        {
            refused.StatusCode.Should().Be(HttpStatusCode.Gone);
        }

        (await brunoClient.GroupIdAsync()).Should().NotBe(aliceGroup);
        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        (await db.GroupInvites.AsNoTracking().SingleAsync(Ct)).UsedAt.Should().BeNull();
    }

    [Fact]
    public async Task TheDailyCleanup_RemovesInvitesThatEndedOverAMonthAgo_AndKeepsTheRest()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);
        await owner.GroupIdAsync();
        for (var i = 0; i < 6; i++)
        {
            await NewInviteAsync(owner);
        }

        // Seis convites: vencido, usado e cancelado há 40 dias (saem); vencido há 10 dias, cancelado ontem e pendente (ficam).
        await using (var conn = new NpgsqlConnection(app.Database.OwnerConnection))
        {
            await conn.OpenAsync(Ct);
            await using var command = new NpgsqlCommand(
                """
                WITH ordered AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM shopping.group_invites)
                UPDATE shopping.group_invites i SET
                    created_at = now() - interval '60 days',
                    expires_at = CASE o.n WHEN 1 THEN now() - interval '40 days' WHEN 4 THEN now() - interval '10 days' ELSE now() + interval '1 day' END,
                    used_at = CASE o.n WHEN 2 THEN now() - interval '40 days' END,
                    used_by = CASE o.n WHEN 2 THEN i.created_by END,
                    revoked_at = CASE o.n WHEN 3 THEN now() - interval '40 days' WHEN 5 THEN now() - interval '1 day' END
                FROM ordered o WHERE o.id = i.id
                """,
                conn);
            (await command.ExecuteNonQueryAsync(Ct)).Should().Be(6);
        }

        var results = await app.Services.GetRequiredService<AuditPurgeService>().RunOnceAsync(Ct);

        results.Should().ContainSingle(r => r.Name == "shopping.invites").Which.Removed.Should().Be(3);
        (await ShoppingClient.OkAsync(owner.GetAsync("/group/invites"))).GetArrayLength().Should().Be(1, "o pendente continua valendo");
        await using var db = TrainingApp.CreateShoppingContext(app.Database.OwnerConnection);
        (await db.GroupInvites.AsNoTracking().CountAsync(Ct)).Should().Be(3);
    }

    [Theory]
    [InlineData("Leite condensado", "", "mercearia")]
    [InlineData("Bananas", "", "hortifruti")]
    [InlineData("Coisa estranha", "", "outros")]
    [InlineData("Leite", "bebidas", "bebidas")]
    public async Task AProductWithoutCategory_GetsTheOneOfItsName(string name, string section, string expected)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = new ShoppingClient(app, (await app.LoginAsync()).AccessToken);

        var product = await ShoppingClient.OkAsync(owner.WriteAsync(
            HttpMethod.Put, $"/products/{Guid.NewGuid()}", new() { ["name"] = name, ["section"] = section }));

        product.GetProperty("section").GetString().Should().Be(expected);
    }
}
