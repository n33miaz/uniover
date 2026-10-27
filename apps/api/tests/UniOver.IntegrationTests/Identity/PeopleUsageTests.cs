using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Audit;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training;
using UniOver.IntegrationTests.Tv;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Training.Domain.Sessions;

namespace UniOver.IntegrationTests.Identity;

/// <summary>
/// O uso por pessoa que o dono lê em Pessoas: último acesso e sessões (do Identity) e as contagens que a TV e o Treino
/// entregam pela porta do SharedKernel. Banco com todos os módulos migrados, Host real, relógio falso.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class PeopleUsageTests(PostgresFixture postgres)
{
    private const string Route = "/api/v1/identity/people-usage";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static JsonElement Person(JsonElement list, Guid id) =>
        list.EnumerateArray().Single(p => p.GetProperty("id").GetGuid() == id);

    private static (int Seven, int Thirty) Counts(JsonElement person, string name) =>
        (person.GetProperty(name).GetProperty("last7Days").GetInt32(), person.GetProperty(name).GetProperty("last30Days").GetInt32());

    private static async Task AddSessionsAsync(TestDatabase database, params Session[] sessions)
    {
        await using var db = TrainingApp.CreateContext(database.OwnerConnection);
        db.Set<Session>().AddRange(sessions);
        await db.SaveChangesAsync(Ct);
    }

    private static Session Workout(Guid user, DateTimeOffset startedAt, bool finished = true, bool deleted = false) => new()
    {
        Id = Guid.CreateVersion7(),
        UserId = user,
        DeviceId = "aparelho-a",
        StartedAt = startedAt,
        FinishedAt = finished ? startedAt.AddMinutes(50) : null,
        DeletedAt = deleted ? startedAt.AddHours(2) : null,
        CreatedAt = startedAt,
        UpdatedAt = startedAt,
        ClientUpdatedAt = startedAt,
    };

    [Fact]
    public async Task OnlyTheOwnerReads_AnonymousIs401_AGuestIs403()
    {
        var (database, _) = await AuditKit.MigrateEverythingAsync(postgres);
        await using var app = await AuditKit.StartAppAsync(postgres, database);
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());

        using var anonymous = await app.GetAsync(Route, bearer: null);
        using var asGuest = await app.GetAsync(Route, guest.Login.AccessToken);
        using var asOwner = await app.GetAsync(Route, owner.AccessToken);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        asOwner.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task EachPersonGetsOnlyTheirOwnNumbers_FromTheTvAndTheTraining()
    {
        var (database, _) = await AuditKit.MigrateEverythingAsync(postgres);
        await using var app = await AuditKit.StartAppAsync(postgres, database);
        var owner = await app.LoginAsync();
        var ownerId = await AuditKit.OwnerIdAsync(app);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Bia");
        var other = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow(), "Caio");
        var now = app.Time.GetUtcNow();

        // A convidada: 3 comandos na semana, mais 2 entre 8 e 29 dias e 1 fora dos 30 dias (não entra).
        // Comandos que não vão à TV (atalhos) e o teto de registro não contam.
        await AuditKit.AddAsync(
            database,
            AuditKit.Command(guest.UserId, TvCommandNames.Key, "OK", true, now.AddHours(-1)),
            AuditKit.Command(guest.UserId, TvCommandNames.AppLaunch, "pkg", true, now.AddDays(-3)),
            AuditKit.Command(guest.UserId, TvCommandNames.PowerOff, null, false, now.AddDays(-6)),
            AuditKit.Command(guest.UserId, TvCommandNames.Key, "UP", true, now.AddDays(-10)),
            AuditKit.Command(guest.UserId, TvCommandNames.Wake, null, true, now.AddDays(-29)),
            AuditKit.Command(guest.UserId, TvCommandNames.Key, "OK", true, now.AddDays(-31)),
            AuditKit.Command(guest.UserId, TvCommandNames.ShortcutUpdate, "label", true, now.AddHours(-2)),
            AuditKit.Command(guest.UserId, TvCommandNames.AuditLimit, "limit=100", true, now.AddHours(-3)),
            AuditKit.Command(ownerId, TvCommandNames.Key, "OK", true, now.AddDays(-1)));

        // Treinos: dois terminados na semana, um terminado há 12 dias, um em andamento e um apagado (nenhum dos dois conta).
        await AddSessionsAsync(
            database,
            Workout(guest.UserId, now.AddDays(-1)),
            Workout(guest.UserId, now.AddDays(-4)),
            Workout(guest.UserId, now.AddDays(-12)),
            Workout(guest.UserId, now.AddHours(-1), finished: false),
            Workout(guest.UserId, now.AddDays(-2), deleted: true),
            Workout(ownerId, now.AddDays(-2)));

        using var response = await app.GetAsync(Route, owner.AccessToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var list = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);

        var bia = Person(list, guest.UserId);
        Counts(bia, "tvCommands").Should().Be((3, 5));
        Counts(bia, "workouts").Should().Be((2, 3));
        bia.GetProperty("activeSessions").GetInt32().Should().Be(1);
        bia.GetProperty("lastAccessAt").ValueKind.Should().Be(JsonValueKind.String);
        bia.GetProperty("role").GetString().Should().Be("guest");

        // Isolamento: o que é da Bia não aparece no dono nem no outro convidado.
        var dono = Person(list, ownerId);
        Counts(dono, "tvCommands").Should().Be((1, 1));
        Counts(dono, "workouts").Should().Be((1, 1));
        var caio = Person(list, other.UserId);
        Counts(caio, "tvCommands").Should().Be((0, 0));
        Counts(caio, "workouts").Should().Be((0, 0));

        // Nada além de contagens: nenhum e-mail, IP, tecla nem conteúdo no corpo.
        var raw = list.GetRawText();
        raw.Should().NotContain(guest.Email).And.NotContain("203.0.113.5").And.NotContain("pkg").And.NotContain("UP");
    }

    [Fact]
    public async Task TheWindowsAreInclusiveAtTheEdge_AndFollowTheClock()
    {
        var (database, _) = await AuditKit.MigrateEverythingAsync(postgres);
        await using var app = await AuditKit.StartAppAsync(postgres, database);
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var now = app.Time.GetUtcNow();

        await AuditKit.AddAsync(
            database,
            AuditKit.Command(guest.UserId, TvCommandNames.Key, "OK", true, now.AddDays(-7)),
            AuditKit.Command(guest.UserId, TvCommandNames.Key, "OK", true, now.AddDays(-7).AddSeconds(-1)),
            AuditKit.Command(guest.UserId, TvCommandNames.Key, "OK", true, now.AddDays(-30)),
            AuditKit.Command(guest.UserId, TvCommandNames.Key, "OK", true, now.AddDays(-30).AddSeconds(-1)));

        using var first = await app.GetAsync(Route, owner.AccessToken);
        var before = Person(await first.Content.ReadFromJsonAsync<JsonElement>(Ct), guest.UserId);
        Counts(before, "tvCommands").Should().Be((1, 3));

        // Um dia depois a linha de exatamente sete dias já saiu da semana (as duas de sete dias seguem no mês), e as de trinta
        // saíram do mês (e o token venceu: entra de novo).
        app.Time.Advance(TimeSpan.FromDays(1));
        var again = await app.LoginAsync();
        using var second = await app.GetAsync(Route, again.AccessToken);
        var later = Person(await second.Content.ReadFromJsonAsync<JsonElement>(Ct), guest.UserId);
        Counts(later, "tvCommands").Should().Be((0, 2));
    }

    [Fact]
    public async Task RevokedSessionsStopCounting_AndTheLastAccessIsTheNewestUse()
    {
        var (database, _) = await AuditKit.MigrateEverythingAsync(postgres);
        await using var app = await AuditKit.StartAppAsync(postgres, database);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        var created = app.Time.GetUtcNow();
        app.Time.Advance(TimeSpan.FromHours(2));
        var owner = await app.LoginAsync();

        await using (var db = app.Db())
        {
            await db.RefreshTokens.Where(t => t.UserId == guest.UserId)
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedAt, app.Time.GetUtcNow()), Ct);
        }

        using var response = await app.GetAsync(Route, owner.AccessToken);
        var bia = Person(await response.Content.ReadFromJsonAsync<JsonElement>(Ct), guest.UserId);
        bia.GetProperty("activeSessions").GetInt32().Should().Be(0);
        DateTimeOffset.Parse(bia.GetProperty("lastAccessAt").GetString()!, System.Globalization.CultureInfo.InvariantCulture)
            .Should().BeOnOrAfter(created.AddSeconds(-1));
    }
}
