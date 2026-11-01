using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class TvAccessTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly string[] ControlOnly = ["module:tv", "tv:control"];

    [Fact]
    public async Task Access_FollowsTheSameVisibilityRuleAsTheTvScreen_ForEachPerson()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var second = await app.PairAsync("PC Quarto");
        var secondTv = Guid.NewGuid();
        await app.ExecuteSqlAsync(
            "INSERT INTO tv.tvs (id, name, agent_slug, is_default, created_at, updated_at, updated_by) " +
            $"VALUES ('{secondTv}', 'Quarto', '{second.Slug}', false, now(), now(), gen_random_uuid())");
        var defaultTv = await DefaultTvAsync(app);

        var unmarked = await app.NewGuestAsync("Sem marca", ControlOnly, 31);
        var inBedroom = await app.NewGuestAsync("No quarto", ControlOnly, 32);
        var removed = await app.NewGuestAsync("Retirada", ControlOnly, 33);
        await app.ExecuteSqlAsync($"INSERT INTO tv.tv_members (tv_id, user_id, added_at) VALUES ('{secondTv}', '{inBedroom.UserId}', now())");
        await app.ExecuteSqlAsync($"INSERT INTO tv.tv_member_optouts (user_id, created_at) VALUES ('{removed.UserId}', now())");

        using var response = await app.GetAsync(
            $"/api/v1/tv/tvs/access?userId={unmarked.UserId}&userId={inBedroom.UserId}&userId={removed.UserId}&userId={unmarked.UserId}");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var people = (await TvApp.JsonAsync(response)).GetProperty("items").EnumerateArray()
            .ToDictionary(
                p => p.GetProperty("userId").GetGuid(),
                p => p.GetProperty("tvIds").EnumerateArray().Select(id => id.GetGuid()).ToList());
        people.Should().HaveCount(3, "o pedido repetido de uma conta conta uma vez só");
        people[unmarked.UserId].Should().BeEquivalentTo(new[] { defaultTv }, "quem nunca teve filiação segue na TV padrão");
        people[inBedroom.UserId].Should().BeEquivalentTo(new[] { secondTv });
        people[removed.UserId].Should().BeEmpty("quem foi retirado não volta à TV padrão");
    }

    [Fact]
    public async Task Access_WithNoPeople_IsEmpty_AndTooManyIsRefused()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var none = await app.GetAsync("/api/v1/tv/tvs/access");
        using var many = await app.GetAsync("/api/v1/tv/tvs/access?" + string.Join('&', Enumerable.Range(0, 51).Select(_ => $"userId={Guid.NewGuid()}")));

        none.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(none)).GetProperty("items").GetArrayLength().Should().Be(0);
        many.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Access_IsRefusedToEveryGuest_WhateverThePermissions_AndToAnonymous()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("Convidada", ["module:tv", "tv:control", "tv:power", "tv:launch", "tv:edit-shortcuts", "tv:history"], 34);

        using var asGuest = await app.GetAsync($"/api/v1/tv/tvs/access?userId={guest.UserId}", bearer: guest.Login.AccessToken);
        using var asAnonymous = await app.GetAsync($"/api/v1/tv/tvs/access?userId={guest.UserId}", bearer: null);

        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        asAnonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await asGuest.Content.ReadAsStringAsync(Ct)).Should().NotContain(guest.UserId.ToString());
    }

    private static async Task<Guid> DefaultTvAsync(TvApp app)
    {
        await using var db = app.Db();
        return await db.Tvs.Where(t => t.IsDefault).Select(t => t.Id).SingleAsync(Ct);
    }
}
