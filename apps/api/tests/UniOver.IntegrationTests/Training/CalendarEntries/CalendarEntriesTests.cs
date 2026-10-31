using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.CalendarEntries;

[Collection(PostgresGroup.Name)]
public sealed class CalendarEntriesTests(PostgresFixture postgres)
{
    private const string Url = "/api/v1/training/calendar-entries/2026-10-27";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static object Body(DateTimeOffset at, bool absent = true, string? note = "Viagem", bool deleted = false) =>
        new { absent, note, clientUpdatedAt = at, deleted };

    [Fact]
    public async Task Entries_AreIsolatedTombstonedAndPulledByCursor()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var other = await app.NewGuestAsync("Outra", ["module:training"], 91);
        var at = DateTimeOffset.UtcNow;

        using (var write = await app.SendAsync(HttpMethod.Put, Url, Body(at), owner.AccessToken, Guid.NewGuid()))
            write.StatusCode.Should().Be(HttpStatusCode.OK);

        using (var foreign = await app.PullResourceAsync(other.Login, "calendar-entries", null, 10))
            (await TrainingApp.JsonAsync(foreign)).GetProperty("items").GetArrayLength().Should().Be(0);

        string? cursor;
        using (var first = await app.PullResourceAsync(owner, "calendar-entries", null, 10))
        {
            var page = await TrainingApp.JsonAsync(first);
            page.GetProperty("items")[0].GetProperty("absent").GetBoolean().Should().BeTrue();
            page.GetProperty("items")[0].GetProperty("dayKey").GetString().Should().Be("2026-10-27");
            cursor = page.GetProperty("nextCursor").GetString();
        }

        using (var delete = await app.SendAsync(HttpMethod.Put, Url, Body(at.AddMinutes(1), false, null, true), owner.AccessToken, Guid.NewGuid()))
            delete.StatusCode.Should().Be(HttpStatusCode.OK);

        using var pulled = await app.PullResourceAsync(owner, "calendar-entries", cursor, 10);
        var item = (await TrainingApp.JsonAsync(pulled)).GetProperty("items")[0];
        item.GetProperty("deleted").GetBoolean().Should().BeTrue();
        item.GetProperty("note").ValueKind.Should().Be(JsonValueKind.Null);

        // Nunca há DELETE físico: a linha segue lá como lápide.
        await using var db = app.Db();
        (await db.Set<CalendarEntry>().SingleAsync(Ct)).DeletedAt.Should().NotBeNull();
    }

    [Fact]
    public async Task TwoUsers_WritingTheSameDay_NeverShareARow()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var other = await app.NewGuestAsync("Outra", ["module:training"], 92);
        var at = DateTimeOffset.UtcNow;

        using (var mine = await app.SendAsync(HttpMethod.Put, Url, Body(at, true, "Minha"), owner.AccessToken, Guid.NewGuid()))
            mine.StatusCode.Should().Be(HttpStatusCode.OK);
        using (var theirs = await app.SendAsync(HttpMethod.Put, Url, Body(at, false, "Dela"), other.Login.AccessToken, Guid.NewGuid()))
            theirs.StatusCode.Should().Be(HttpStatusCode.OK);

        await using var db = app.Db();
        var rows = await db.Set<CalendarEntry>().OrderBy(x => x.Note).ToListAsync(Ct);
        rows.Select(x => x.Note).Should().Equal("Dela", "Minha");
        rows.Select(x => x.UserId).Distinct().Should().HaveCount(2);
    }

    [Fact]
    public async Task OlderWrite_DoesNotOverwriteANewerOne_AndNewerWins()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var at = DateTimeOffset.UtcNow;

        using (var newer = await app.SendAsync(HttpMethod.Put, Url, Body(at, true, "Nova"), owner.AccessToken, Guid.NewGuid()))
            newer.StatusCode.Should().Be(HttpStatusCode.OK);
        using (var older = await app.SendAsync(HttpMethod.Put, Url, Body(at.AddMinutes(-5), false, "Antiga"), owner.AccessToken, Guid.NewGuid()))
        {
            older.StatusCode.Should().Be(HttpStatusCode.OK);
            (await TrainingApp.JsonAsync(older)).GetProperty("note").GetString().Should().Be("Nova");
        }

        using (var newest = await app.SendAsync(HttpMethod.Put, Url, Body(at.AddMinutes(5), false, "Mais nova"), owner.AccessToken, Guid.NewGuid()))
            newest.StatusCode.Should().Be(HttpStatusCode.OK);

        await using var db = app.Db();
        var row = await db.Set<CalendarEntry>().SingleAsync(Ct);
        row.Note.Should().Be("Mais nova");
        row.Absent.Should().BeFalse();
    }

    [Fact]
    public async Task InvalidBodies_AreRejected_AndNothingIsStored()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var at = DateTimeOffset.UtcNow;

        using var badDay = await app.SendAsync(HttpMethod.Put, "/api/v1/training/calendar-entries/amanha", Body(at), owner.AccessToken, Guid.NewGuid());
        using var longNote = await app.SendAsync(HttpMethod.Put, Url, Body(at, false, new string('a', 281)), owner.AccessToken, Guid.NewGuid());
        using var empty = await app.SendAsync(HttpMethod.Put, Url, Body(at, false, "  "), owner.AccessToken, Guid.NewGuid());
        using var noClock = await app.SendAsync(HttpMethod.Put, Url, new { absent = true }, owner.AccessToken, Guid.NewGuid());

        foreach (var response in new[] { badDay, longNote, empty, noClock })
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        await using var db = app.Db();
        (await db.Set<CalendarEntry>().CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task ClockMoreThan24HoursAhead_Returns422_AndJustUnderIsAccepted()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var ahead = await app.SendAsync(HttpMethod.Put, Url, Body(DateTimeOffset.UtcNow.AddHours(25)), owner.AccessToken, Guid.NewGuid());
        using var edge = await app.SendAsync(HttpMethod.Put, Url, Body(DateTimeOffset.UtcNow.AddHours(23)), owner.AccessToken, Guid.NewGuid());

        ahead.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(ahead)).Should().EndWith("client-clock-ahead");
        edge.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Migration_AddsOnlyTheTable_KeepsTheRuntimeRoleWithoutDdl_AndTheChecksHold()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { MigrateTraining = false });
        await using (var training = TrainingApp.CreateContext(app.Database.OwnerConnection))
        {
            await training.Database.MigrateAsync("20261028010130_AddBodyMeasurements", Ct);
            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().Equal("20261028024002_AddCalendarEntries");
            await training.Database.MigrateAsync(Ct);
            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().BeEmpty();
        }

        await using var connection = new NpgsqlConnection(app.Database.RuntimeConnection);
        await connection.OpenAsync(Ct);
        (await InsertAsync(connection, "2026-10-27", true, null, false)).Should().Be(1);

        // Um dia por usuário, uma nota de até 280 caracteres, e um dia vivo precisa de ausência ou de nota.
        var userId = Guid.NewGuid();
        (await InsertAsync(connection, "2026-10-27", true, null, false, userId)).Should().Be(1);
        (await Assert.ThrowsAsync<PostgresException>(() => InsertAsync(connection, "2026-10-27", true, null, false, userId))).SqlState.Should().Be("23505");
        (await Assert.ThrowsAsync<PostgresException>(() => InsertAsync(connection, "2026-10-28", false, new string('a', 281), false))).SqlState.Should().BeOneOf("22001", "23514");
        (await Assert.ThrowsAsync<PostgresException>(() => InsertAsync(connection, "2026-10-28", false, null, false))).SqlState.Should().Be("23514");
        (await InsertAsync(connection, "2026-10-28", false, null, true)).Should().Be(1);

        await using var ddl = new NpgsqlCommand("CREATE TABLE training.calendar_entries_intruder (id int)", connection);
        (await Assert.ThrowsAsync<PostgresException>(() => ddl.ExecuteNonQueryAsync(Ct))).SqlState.Should().Be("42501");
    }

    private static async Task<int> InsertAsync(NpgsqlConnection connection, string day, bool absent, string? note, bool tombstone, Guid? userId = null)
    {
        await using var insert = new NpgsqlCommand(
            "INSERT INTO training.calendar_entries (id, user_id, day, absent, note, created_at, updated_at, client_updated_at, deleted_at) "
            + "VALUES (gen_random_uuid(), @user, @day::date, @absent, @note, now(), now(), now(), CASE WHEN @tombstone THEN now() END)", connection);
        insert.Parameters.AddWithValue("user", userId ?? Guid.NewGuid());
        insert.Parameters.AddWithValue("day", day);
        insert.Parameters.AddWithValue("absent", absent);
        insert.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
        insert.Parameters.AddWithValue("tombstone", tombstone);
        return await insert.ExecuteNonQueryAsync(Ct);
    }

    [Fact]
    public async Task Pull_PagesByCursor_WithoutRepeatingOrSkipping()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var at = DateTimeOffset.UtcNow;
        foreach (var day in new[] { "2026-10-25", "2026-10-26", "2026-10-27" })
        {
            using var write = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/calendar-entries/{day}", Body(at, true, null), owner.AccessToken, Guid.NewGuid());
            write.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var seen = new List<string>();
        string? cursor = null;
        for (var page = 0; page < 5; page++)
        {
            using var response = await app.PullResourceAsync(owner, "calendar-entries", cursor, 2);
            var json = await TrainingApp.JsonAsync(response);
            var items = json.GetProperty("items");
            if (items.GetArrayLength() == 0) break;
            seen.AddRange(items.EnumerateArray().Select(item => item.GetProperty("dayKey").GetString()!));
            cursor = json.GetProperty("nextCursor").GetString();
        }

        seen.Should().BeEquivalentTo(["2026-10-25", "2026-10-26", "2026-10-27"]);
        seen.Should().OnlyHaveUniqueItems();
    }
}
