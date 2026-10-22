using System.Globalization;
using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Body;
using static UniOver.IntegrationTests.Training.BodyMetrics.BodyHelpers;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.BodyMetrics;

/// <summary>
/// Duas pessoas convidadas só com o Treino (Alice e Bruno) e o administrador, cada uma com o próprio corpo (medição e perfil).
/// A prova é a mesma do restante do Treino: o que uma lê, grava, apaga ou adivinha nunca alcança a outra, a leitura
/// incremental só devolve linhas do próprio chamador (qualquer cursor que ele mande), a chave de idempotência é de quem a
/// usa e nenhum dado de saúde vai para o log. Como o corpo é dado sensível, o teste vigia também o texto das respostas.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class BodyIsolationTests(PostgresFixture postgres)
{
    private static readonly string[] Members = ["module:training"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Tudo o que uma pessoa gravou, e os valores que só ela pode ver.</summary>
    private sealed record Data(Guid EntryId, string Secret, decimal Weight, decimal Height, string BirthDate);

    private sealed class World(TrainingApp app, LoggedIn owner, GuestSession alice, GuestSession bruno, Data a, Data b) : IAsyncDisposable
    {
        public TrainingApp App { get; } = app;

        public LoggedIn Owner { get; } = owner;

        public GuestSession Alice { get; } = alice;

        public GuestSession Bruno { get; } = bruno;

        public Data A { get; } = a;

        public Data B { get; } = b;

        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    private async Task<World> StartAsync(TrainingAppOptions? options = null)
    {
        var app = await TrainingApp.StartAsync(postgres, options);
        try
        {
            var owner = await app.LoginAsync();
            var alice = await app.NewGuestAsync("Alice", Members, 71);
            var bruno = await app.NewGuestAsync("Bruno", Members, 72);
            var a = await SeedAsync(app, alice.Login, "alice", weight: 123.45m, height: 187.3m, birthDate: "1987-03-21");
            var b = await SeedAsync(app, bruno.Login, "bruno", weight: 67.89m, height: 161.7m, birthDate: "1999-11-02");
            return new World(app, owner, alice, bruno, a, b);
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }
    }

    private static async Task<Data> SeedAsync(TrainingApp app, LoggedIn login, string who, decimal weight, decimal height, string birthDate)
    {
        var secret = $"segredo-{who}";
        var now = DateTimeOffset.UtcNow;

        var entryId = Guid.CreateVersion7();
        using (var response = await app.PutEntryAsync(
            login, entryId, EntryBody(now, weightKg: weight, bodyFatPct: 21.3m, fatMethod: "manual", waistCm: 91.7m, note: $"Nota {secret}")))
        {
            response.EnsureSuccessStatusCode();
        }

        using (var response = await app.PutProfileAsync(login, ProfileBody(now, heightCm: height, birthDate: birthDate)))
        {
            response.EnsureSuccessStatusCode();
        }

        return new Data(entryId, secret, weight, height, birthDate);
    }

    private static Guid IdOf(JsonElement row) => row.GetProperty("id").GetGuid();

    private static string Text(decimal value) => value.ToString(CultureInfo.InvariantCulture);

    private static async Task<string> ShapeOfAsync(Task<HttpResponseMessage> call)
    {
        using var response = await call;
        return await ProblemShape.OfAsync(response);
    }

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    [Fact]
    public async Task EveryBodyPull_ReturnsOnlyTheRowsOfTheCaller_TheOwnerIncluded()
    {
        await using var w = await StartAsync();

        await AssertOnlyOwnAsync(w.App, "Alice", w.Alice.Login, w.A, foreign: w.B);
        await AssertOnlyOwnAsync(w.App, "Bruno", w.Bruno.Login, w.B, foreign: w.A);

        // O administrador também só lê o que é dele: ser dono do sistema não é ser dono do corpo dos outros.
        await AssertOnlyOwnAsync(w.App, "dono", w.Owner, null, foreign: w.A);
        await AssertOnlyOwnAsync(w.App, "dono", w.Owner, null, foreign: w.B);
    }

    private static async Task AssertOnlyOwnAsync(TrainingApp app, string who, LoggedIn login, Data? mine, Data foreign)
    {
        foreach (var resource in new[] { "body/entries", "body/profile" })
        {
            var pages = await app.PullAllAsync(login, resource, 500);
            var rows = pages.Rows().ToList();
            var text = string.Concat(pages.Select(p => p.GetRawText()));

            text.Should().NotContain(foreign.Secret, $"{who} lendo {resource}");
            text.Should().NotContain(Text(foreign.Weight), $"{who} lendo {resource}");
            text.Should().NotContain(Text(foreign.Height), $"{who} lendo {resource}");
            text.Should().NotContain(foreign.BirthDate, $"{who} lendo {resource}");

            if (resource == "body/entries")
            {
                rows.Select(IdOf).Should().Equal(mine is null ? [] : [mine.EntryId], $"{who} lendo {resource}");
            }
            else
            {
                rows.Should().HaveCount(mine is null ? 0 : 1, $"{who} lendo {resource}");
            }
        }
    }

    [Fact]
    public async Task BrunoCannotWriteOnTheEntryOfAlice_AndNothingOfHersChanges_AndTheProfileWriteStaysHis()
    {
        await using var w = await StartAsync();
        var app = w.App;
        var b = w.Bruno.Login;
        var now = DateTimeOffset.UtcNow;

        var attempts = new (string Label, Func<Task<HttpResponseMessage>> Call)[]
        {
            ("PUT entries/{alice}", () => app.PutEntryAsync(b, w.A.EntryId, EntryBody(now.AddMinutes(1), weightKg: 50m, note: "Invadido"))),
            ("PUT entries/{alice} apagando", () => app.PutEntryAsync(b, w.A.EntryId, EntryBody(now.AddMinutes(2), deleted: true))),
            ("PUT entries/{alice} só a lápide", () => app.PutEntryAsync(b, w.A.EntryId, EntryBody(now.AddMinutes(3), weightKg: null, deleted: true))),
        };

        var shapes = new List<string>();
        foreach (var (label, call) in attempts)
        {
            using var response = await call();
            response.StatusCode.Should().Be(HttpStatusCode.NotFound, label);
            var shape = await ProblemShape.OfAsync(response);
            shape.Should().NotContain(w.A.EntryId.ToString(), $"{label}: a resposta não repete o id");
            shapes.Add(shape);
        }

        shapes.Distinct().Should().ContainSingle("a recusa tem sempre a mesma forma");

        // O perfil não tem id na rota: o PUT do Bruno é o PERFIL DELE e nunca toca no da Alice.
        using (var profile = await app.PutProfileAsync(b, ProfileBody(now.AddMinutes(4), heightCm: 170m)))
        {
            profile.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await using var db = app.Db();
        var alice = await db.Set<BodyEntry>().SingleAsync(e => e.Id == w.A.EntryId, Ct);
        alice.UserId.Should().Be(w.Alice.UserId);
        alice.WeightKg.Should().Be(w.A.Weight);
        alice.Note.Should().Be($"Nota {w.A.Secret}");
        alice.DeletedAt.Should().BeNull();
        (await db.Set<BodyEntry>().CountAsync(e => e.UserId == w.Bruno.UserId, Ct)).Should().Be(1, "só a medição do próprio Bruno");
        (await db.Set<BodyProfile>().SingleAsync(p => p.UserId == w.Alice.UserId, Ct)).HeightCm.Should().Be(w.A.Height);
        (await db.Set<BodyProfile>().SingleAsync(p => p.UserId == w.Bruno.UserId, Ct)).HeightCm.Should().Be(170m);
    }

    [Fact]
    public async Task TheCursorOfBruno_NeverReturnsRowsOfAlice_NoMatterWhereItPoints()
    {
        await using var w = await StartAsync();
        var app = w.App;
        var fromTheBeginning = new PullCursor(DateTimeOffset.UnixEpoch, Guid.Empty).Encode();

        foreach (var resource in new[] { "body/entries", "body/profile" })
        {
            using var fromEpoch = await app.PullResourceAsync(w.Bruno.Login, resource, after: fromTheBeginning, limit: 500);
            var epochText = await fromEpoch.Content.ReadAsStringAsync(Ct);

            // Com o cursor da PRÓPRIA Alice (a posição da última linha dela): continua só com linhas do Bruno.
            using var alicePage = await app.PullResourceAsync(w.Alice.Login, resource, limit: 500);
            var aliceCursor = (await TrainingApp.JsonAsync(alicePage)).GetProperty("nextCursor").GetString();
            using var withAlicesCursor = await app.PullResourceAsync(w.Bruno.Login, resource, after: aliceCursor, limit: 500);
            var cursorText = await withAlicesCursor.Content.ReadAsStringAsync(Ct);

            foreach (var text in new[] { epochText, cursorText })
            {
                text.Should().NotContain(w.A.Secret, resource).And.NotContain(Text(w.A.Weight), resource)
                    .And.NotContain(Text(w.A.Height), resource).And.NotContain(w.A.EntryId.ToString(), resource);
            }

            using var json = JsonDocument.Parse(epochText);
            json.RootElement.GetProperty("items").GetArrayLength().Should().Be(1, $"{resource}: o Bruno vê só a linha dele");
        }
    }

    [Fact]
    public async Task TheSameIdempotencyKey_UsedByTwoPeople_NeitherCollidesNorRevealsTheOther()
    {
        await using var w = await StartAsync();
        var app = w.App;
        var key = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var sameProfile = ProfileBody(now.AddMinutes(1), heightCm: 175m);

        // A mesma URL, a mesma chave e o MESMO corpo em duas contas: cada uma executa a sua, sem repetir a resposta da outra.
        using var alice = await app.PutProfileAsync(w.Alice.Login, sameProfile, key);
        using var bruno = await app.PutProfileAsync(w.Bruno.Login, sameProfile, key);
        alice.StatusCode.Should().Be(HttpStatusCode.OK);
        bruno.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(alice).Should().BeFalse();
        Replayed(bruno).Should().BeFalse("a resposta guardada é da Alice, não do Bruno");

        // Controle: para a PRÓPRIA Alice a trava existe (outro corpo é recusado, o mesmo corpo repete a resposta guardada).
        using var reused = await app.PutProfileAsync(w.Alice.Login, ProfileBody(now.AddMinutes(2), heightCm: 176m), key);
        reused.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        using var again = await app.PutProfileAsync(w.Alice.Login, sameProfile, key);
        Replayed(again).Should().BeTrue();

        // E uma chave que a Alice usou numa rota serve ao Bruno em OUTRA rota: nada de "chave reusada" entre pessoas.
        var crossKey = Guid.NewGuid();
        using var aliceEntry = await app.PutEntryAsync(w.Alice.Login, Guid.CreateVersion7(), EntryBody(now, weightKg: 70m), crossKey);
        using var brunoProfile = await app.PutProfileAsync(w.Bruno.Login, ProfileBody(now.AddMinutes(3), heightCm: 173m), crossKey);
        aliceEntry.StatusCode.Should().Be(HttpStatusCode.OK);
        brunoProfile.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(brunoProfile).Should().BeFalse();

        await using var db = app.Db();
        var owners = await db.Set<IdempotencyRecord>().Where(r => r.Key == key).Select(r => r.UserId).ToListAsync(Ct);
        owners.Should().BeEquivalentTo([w.Alice.UserId, w.Bruno.UserId]);
    }

    [Fact]
    public async Task NoHealthValue_GoesToTheLog_NotEvenWhileTheSqlIsLogged()
    {
        await using var w = await StartAsync(new TrainingAppOptions { CaptureSql = true });
        var now = DateTimeOffset.UtcNow;

        // Leituras, escritas recusadas (validação, medição vazia, id alheio) e escritas aceitas: tudo passa pelo log capturado.
        (await w.App.PullEntriesAsync(w.Bruno.Login)).Dispose();
        (await w.App.PullProfileAsync(w.Bruno.Login)).Dispose();
        (await w.App.PutEntryAsync(w.Bruno.Login, w.A.EntryId, EntryBody(now, weightKg: 99.99m, note: "Invadido"))).Dispose();
        (await w.App.PutEntryAsync(w.Bruno.Login, Guid.CreateVersion7(), EntryBody(now, weightKg: 4321.5m))).Dispose();
        (await w.App.PutEntryAsync(w.Bruno.Login, Guid.CreateVersion7(), EntryBody(now, weightKg: null, note: "vazia"))).Dispose();
        (await w.App.PutProfileAsync(w.Bruno.Login, ProfileBody(now, heightCm: 99.9m, birthDate: "2001-02-03"))).Dispose();
        (await w.App.PutProfileAsync(w.Bruno.Login, ProfileBody(now.AddSeconds(1), heightCm: 188.8m, birthDate: "2002-04-05"))).Dispose();

        var lines = w.App.Logs.Lines;
        lines.Should().NotBeEmpty("o log capturado tem de ter visto o SQL, senão a prova não vale");
        foreach (var secret in new[]
        {
            w.A.Secret, w.B.Secret,
            Text(w.A.Weight), Text(w.B.Weight), Text(w.A.Height), Text(w.B.Height), w.A.BirthDate, w.B.BirthDate,
            "99.99", "4321.5", "188.8", "2002-04-05", "2001-02-03",
            w.Alice.Login.AccessToken, w.Bruno.Login.AccessToken, w.Alice.Password, w.Bruno.Password,
        })
        {
            lines.Should().NotContain(l => l.Contains(secret, StringComparison.Ordinal), "dado de saúde e credencial nunca vão ao log");
        }
    }
}
