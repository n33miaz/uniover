using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain.Body;
using static UniOver.IntegrationTests.Training.BodyMetrics.BodyHelpers;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.BodyMetrics;

[Collection(PostgresGroup.Name)]
public sealed class PullBodyTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task WithoutLogin_Returns401_OnBothReads()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var entries = await app.PullEntriesAsync(null);
        using var profile = await app.PullProfileAsync(null);

        entries.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        profile.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task WithNothingStored_BothReadsReturnAnEmptyPage_AndNoCursor()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        foreach (var response in new[] { await app.PullEntriesAsync(login), await app.PullProfileAsync(login) })
        {
            using (response)
            {
                var page = await TrainingApp.JsonAsync(response);
                response.StatusCode.Should().Be(HttpStatusCode.OK);
                page.GetProperty("items").GetArrayLength().Should().Be(0);
                page.GetProperty("nextCursor").ValueKind.Should().Be(JsonValueKind.Null);
            }
        }
    }

    [Fact]
    public async Task EntryPages_NeverRepeatNorSkip_EvenWithTheSameUpdatedAt_AndTombstonesComeToo()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var userId = TrainingApp.UserIdOf(login);
        var sameInstant = DateTimeOffset.UtcNow.AddMinutes(-3);
        var entries = new List<BodyEntry>
        {
            NewEntry(userId, 80m, sameInstant),
            NewEntry(userId, 81m, sameInstant),
            NewEntry(userId, 82m, sameInstant),
            NewEntry(userId, 83m, sameInstant),
            NewEntry(userId, deleted: true, updatedAt: sameInstant),
        };
        await using (var seed = app.Db())
        {
            seed.AddRange(entries);
            await seed.SaveChangesAsync(Ct);
        }

        var pulled = (await app.PullAllAsync(login, "body/entries", limit: 2)).Rows().ToList();

        pulled.Should().HaveCount(5);
        pulled.Select(r => r.GetProperty("id").GetGuid()).Should().OnlyHaveUniqueItems();
        pulled.Select(r => r.GetProperty("id").GetGuid()).Should().Equal(entries.Select(e => e.Id).Order());
        var tombstone = pulled.Single(r => r.GetProperty("deleted").GetBoolean());
        tombstone.GetProperty("weightKg").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task ThePullComesBackInTheOrderOfTheServerClock_SoALaterWriteIsSeenAgain()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutEntryAsync(login, id, EntryBody(now, weightKg: 80m)))
        {
        }

        string? cursor;
        using (var first = await app.PullEntriesAsync(login))
        {
            cursor = (await TrainingApp.JsonAsync(first)).GetProperty("nextCursor").GetString();
        }

        using (await app.PutEntryAsync(login, id, EntryBody(now.AddMinutes(1), weightKg: 79m)))
        {
        }

        using var second = await app.PullEntriesAsync(login, cursor);
        var items = (await TrainingApp.JsonAsync(second)).GetProperty("items");

        items.GetArrayLength().Should().Be(1);
        items[0].GetProperty("weightKg").GetDecimal().Should().Be(79m);
    }

    [Fact]
    public async Task TwoUsers_NeverSeeEachOthersEntries()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        using (await app.PutEntryAsync(login, Guid.CreateVersion7(), EntryBody(DateTimeOffset.UtcNow, weightKg: 80m)))
        {
        }

        var foreign = NewEntry(Guid.NewGuid(), 123.45m);
        await using (var db = app.Db())
        {
            db.Add(foreign);
            await db.SaveChangesAsync(Ct);
        }

        var pulled = (await app.PullAllAsync(login, "body/entries", limit: 50)).Rows().Select(r => r.GetProperty("weightKg").GetDecimal()).ToList();

        pulled.Should().Equal(80m);
    }

    [Fact]
    public async Task TheProfilePull_ReturnsAtMostOneItem_InTheSameEnvelope_AndNothingAfterItsCursor()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        using (await app.PutProfileAsync(login, ProfileBody(now)))
        {
        }

        using var first = await app.PullProfileAsync(login);
        var page = await TrainingApp.JsonAsync(first);
        var cursor = page.GetProperty("nextCursor").GetString();

        page.GetProperty("items").GetArrayLength().Should().Be(1);
        page.GetProperty("items")[0].GetProperty("heightCm").GetDecimal().Should().Be(180m);
        cursor.Should().NotBeNull();

        using var after = await app.PullProfileAsync(login, cursor);
        var empty = await TrainingApp.JsonAsync(after);
        empty.GetProperty("items").GetArrayLength().Should().Be(0, "nada mudou desde o cursor");
        empty.GetProperty("nextCursor").GetString().Should().Be(cursor, "página vazia devolve o cursor que recebeu");

        using (await app.PutProfileAsync(login, ProfileBody(now.AddMinutes(1), heightCm: 181m)))
        {
        }

        using var changed = await app.PullProfileAsync(login, cursor);
        var items = (await TrainingApp.JsonAsync(changed)).GetProperty("items");
        items.GetArrayLength().Should().Be(1);
        items[0].GetProperty("heightCm").GetDecimal().Should().Be(181m);
    }

    [Fact]
    public async Task TwoUsers_NeverSeeEachOthersProfile()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();
        await using (var db = app.Db())
        {
            db.Add(NewProfile(Guid.NewGuid()));
            await db.SaveChangesAsync(Ct);
        }

        using var response = await app.PullProfileAsync(login);

        (await TrainingApp.JsonAsync(response)).GetProperty("items").GetArrayLength().Should().Be(0);
    }

    [Theory]
    [InlineData("body/entries", "não é cursor", null)]
    [InlineData("body/entries", null, 0)]
    [InlineData("body/entries", null, 501)]
    [InlineData("body/profile", "não é cursor", null)]
    [InlineData("body/profile", null, 0)]
    [InlineData("body/profile", null, 501)]
    public async Task InvalidCursorOrLimit_Returns400(string resource, string? after, int? limit)
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.PullResourceAsync(login, resource, after, limit);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
