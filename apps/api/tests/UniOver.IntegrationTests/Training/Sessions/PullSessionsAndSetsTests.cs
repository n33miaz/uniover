using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain.Sessions;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.Sessions;

[Collection(PostgresGroup.Name)]
public sealed class PullSessionsAndSetsTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("sessions")]
    [InlineData("sets")]
    public async Task WithoutLogin_Returns401(string resource)
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.PullResourceAsync(null, resource);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Theory]
    [InlineData("sessions")]
    [InlineData("sets")]
    public async Task WithNothingStored_ReturnsAnEmptyPage_AndNoCursor(string resource)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PullResourceAsync(login, resource);
        var page = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        page.GetProperty("items").GetArrayLength().Should().Be(0);
        page.GetProperty("nextCursor").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Theory]
    [InlineData("sessions", "after=lixo")]
    [InlineData("sessions", "limit=0")]
    [InlineData("sets", "limit=501")]
    [InlineData("sets", "after=%00%00")]
    public async Task InvalidCursorOrLimit_Returns400(string resource, string query)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/{resource}?{query}", bearer: login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Sessions_PagesNeverRepeatNorSkip_TombstonesIncluded_InServerOrder()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var ids = new List<Guid>();
        for (var i = 0; i < 7; i++)
        {
            var id = Guid.CreateVersion7();
            ids.Add(id);
            using var response = await app.PutSessionAsync(login, id, SessionBody(
                now.AddSeconds(i), startedAt: now.AddMinutes(-60 + i), finishedAt: i == 6 ? null : now.AddMinutes(-30 + i), deleted: i == 3));
            response.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var pages = await app.PullAllAsync(login, "sessions", limit: 2);

        pages.Count.Should().BeGreaterThanOrEqualTo(4);
        var rows = pages.Rows().ToList();
        rows.Select(r => r.GetProperty("id").GetGuid()).Should().Equal(ids);
        rows.Single(r => r.GetProperty("id").GetGuid() == ids[3]).GetProperty("deleted").GetBoolean().Should().BeTrue();
        rows.Count(r => r.GetProperty("finishedAt").ValueKind == JsonValueKind.Null).Should().Be(1, "só a última ficou aberta");
    }

    [Fact]
    public async Task Sets_PagesNeverRepeatNorSkip_EvenWhenEverySetHasTheSameUpdatedAt()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var user = TrainingApp.UserIdOf(login);
        using (await app.PutSetAsync(login, await app.OpenSessionAsync(login), Guid.CreateVersion7(), SetBody(DateTimeOffset.UtcNow, CatalogId(0))))
        {
        }

        var session = NewSession(user, finishedAt: DateTimeOffset.UtcNow);
        var stamp = DateTimeOffset.UtcNow.AddMinutes(-5);
        var sets = Enumerable.Range(0, 9).Select(i =>
        {
            var set = NewSet(user, session.Id, CatalogId(0), i);
            set.UpdatedAt = stamp;
            return set;
        }).ToList();
        await using (var db = app.Db())
        {
            db.Add(session);
            await db.SaveChangesAsync(Ct);
            db.AddRange(sets);
            await db.SaveChangesAsync(Ct);
        }

        var pulled = (await app.PullAllAsync(login, "sets", limit: 2)).Rows().Select(r => r.GetProperty("id").GetGuid()).ToList();

        pulled.Should().HaveCount(10);
        pulled.Should().OnlyHaveUniqueItems();
        pulled.Take(9).Should().BeEquivalentTo(sets.Select(s => s.Id), "o empate de instante é resolvido pelo id, sem pular nem repetir");
        pulled.Take(9).Should().Equal(sets.Select(s => s.Id).Order());
    }

    [Fact]
    public async Task TwoUsers_NeverSeeEachOthersSessionsOrSets()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var mine = await app.OpenSessionAsync(login);
        using (await app.PutSetAsync(login, mine, Guid.CreateVersion7(), SetBody(DateTimeOffset.UtcNow, CatalogId(0))))
        {
        }

        var foreign = NewSession(Guid.NewGuid());
        var foreignSet = NewSet(foreign.UserId, foreign.Id, CatalogId(0));
        await using (var db = app.Db())
        {
            db.Add(foreign);
            await db.SaveChangesAsync(Ct);
            db.Add(foreignSet);
            await db.SaveChangesAsync(Ct);
        }

        var sessions = (await app.PullAllAsync(login, "sessions", limit: 50)).Rows().Select(r => r.GetProperty("id").GetGuid()).ToList();
        var sets = (await app.PullAllAsync(login, "sets", limit: 50)).Rows().Select(r => r.GetProperty("id").GetGuid()).ToList();

        sessions.Should().Equal(mine);
        sets.Should().HaveCount(1).And.NotContain(foreignSet.Id);
    }

    [Fact]
    public async Task ThePullReturnsTheDeviceAndTheFinishedState_SoAnotherDeviceSeesWhoIsTraining()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = await app.OpenSessionAsync(login, deviceId: "celular");

        var row = (await app.PullAllAsync(login, "sessions", limit: 10)).Rows().Single();

        row.GetProperty("id").GetGuid().Should().Be(id);
        row.GetProperty("deviceId").GetString().Should().Be("celular");
        row.GetProperty("finishedAt").ValueKind.Should().Be(JsonValueKind.Null);
        row.GetProperty("deleted").GetBoolean().Should().BeFalse();
    }
}
