using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training.Goals;
using UniOver.IntegrationTests.Training.Routines;
using UniOver.IntegrationTests.Training.Sessions;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Goals;
using UniOver.Modules.Training.Domain.Routines;
using UniOver.Modules.Training.Domain.Sessions;

namespace UniOver.IntegrationTests.Training;

/// <summary>
/// Duas pessoas convidadas só com o Treino (Alice e Bruno) e o administrador, cada uma com os próprios dados em TODAS as
/// áreas (exercício próprio, salto de carga, rotina, treino, série, meta). A prova é por rota: o que uma lê, grava, apaga ou
/// adivinha nunca alcança a outra; a leitura incremental só devolve linhas do próprio chamador, qualquer cursor que ele
/// mande; e a chave de idempotência é de quem a usa. Onde a resposta poderia entregar uma pista (id de outra pessoa), ela é
/// idêntica à de um id que não existe.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TrainingIsolationTests(PostgresFixture postgres)
{
    private static readonly string[] Members = ["module:training"];
    private static readonly string[] Resources = ["exercises", "routines", "sessions", "sets", "goals"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Tudo o que uma pessoa gravou no mundo de teste, e o texto que só ela pode ver.</summary>
    private sealed record Data(
        Guid ExerciseId, Guid RoutineId, Guid ItemId, Guid SessionId, Guid SetId, Guid GoalId, string Secret, decimal Step, decimal Weight);

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

            // A primeira leitura do catálogo carrega a semente (preguiçosa): o salto de carga de um exercício dele só existe depois.
            using (var warmUp = await app.PullAsync(owner, limit: 1))
            {
                warmUp.EnsureSuccessStatusCode();
            }

            var alice = await app.NewGuestAsync("Alice", Members, 61);
            var bruno = await app.NewGuestAsync("Bruno", Members, 62);
            var a = await SeedAsync(app, alice.Login, "alice", step: 7.5m, weight: 123.45m);
            var b = await SeedAsync(app, bruno.Login, "bruno", step: 3.25m, weight: 67.89m);
            return new World(app, owner, alice, bruno, a, b);
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }
    }

    /// <summary>Grava, pela API, um item de cada área do Treino para a pessoa; todo texto livre carrega o segredo dela.</summary>
    private static async Task<Data> SeedAsync(TrainingApp app, LoggedIn login, string who, decimal step, decimal weight)
    {
        var secret = $"segredo-{who}";
        var now = DateTimeOffset.UtcNow;
        var catalog = RoutineHelpers.CatalogId(0);

        var exerciseId = Guid.CreateVersion7();
        using (var response = await app.PutCustomAsync(
            login, exerciseId, TrainingApp.CustomBody(now, $"Exercicio {secret}", instructions: [$"Passo {secret}"])))
        {
            response.EnsureSuccessStatusCode();
        }

        using (var response = await app.SendAsync(
            HttpMethod.Put, $"/api/v1/training/exercises/{catalog}/step", new { stepKg = step, clientUpdatedAt = now }, login.AccessToken, Guid.NewGuid()))
        {
            response.EnsureSuccessStatusCode();
        }

        var routineId = Guid.CreateVersion7();
        var itemId = Guid.CreateVersion7();
        using (var response = await app.PutRoutineAsync(
            login,
            routineId,
            RoutineHelpers.Body(
                now,
                [RoutineHelpers.Item(itemId, catalog, 0, note: $"Item {secret}"), RoutineHelpers.Item(Guid.CreateVersion7(), exerciseId, 1)],
                name: $"Rotina {secret}",
                note: $"Nota {secret}")))
        {
            response.EnsureSuccessStatusCode();
        }

        var sessionId = Guid.CreateVersion7();
        using (var response = await app.PutSessionAsync(
            login, sessionId, SessionHelpers.SessionBody(now, routineId: routineId, note: $"Treino {secret}")))
        {
            response.EnsureSuccessStatusCode();
        }

        var setId = Guid.CreateVersion7();
        using (var response = await app.PutSetAsync(
            login, sessionId, setId, SessionHelpers.SetBody(now, catalog, weightKg: weight, reps: 7, note: $"Serie {secret}")))
        {
            response.EnsureSuccessStatusCode();
        }

        Guid goalId;
        using (var response = await app.PutGoalAsync(login, GoalKinds.WeeklySessions, GoalHelpers.GoalBody(now, who == "alice" ? 5m : 2m)))
        {
            response.EnsureSuccessStatusCode();
            goalId = (await TrainingApp.JsonAsync(response)).GetProperty("id").GetGuid();
        }

        return new Data(exerciseId, routineId, itemId, sessionId, setId, goalId, secret, step, weight);
    }

    private static Guid IdOf(JsonElement row) => row.GetProperty("id").GetGuid();

    private static async Task<List<JsonElement>> RowsOfAsync(TrainingApp app, LoggedIn login, string resource, int limit = PullLimit) =>
        (await app.PullAllAsync(login, resource, limit)).Rows().ToList();

    private const int PullLimit = 500;

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    private static async Task<string> ShapeOfAsync(Task<HttpResponseMessage> call)
    {
        using var response = await call;
        return await ProblemShape.OfAsync(response);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Leitura: cada pull devolve só o que é do chamador (e o catálogo compartilhado, que não é de ninguém)
    // ---------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task EveryPull_ReturnsOnlyTheRowsOfTheCaller_TheOwnerIncluded()
    {
        await using var w = await StartAsync();
        var catalog = RoutineHelpers.CatalogId(0);

        await AssertOnlyOwnAsync(w.App, "Alice", w.Alice.Login, w.A, foreign: w.B);
        await AssertOnlyOwnAsync(w.App, "Bruno", w.Bruno.Login, w.B, foreign: w.A);

        // O administrador também só lê o que é dele: ser dono do sistema não é ser dono dos dados dos outros.
        await AssertOnlyOwnAsync(w.App, "dono", w.Owner, null, foreign: w.A);
        await AssertOnlyOwnAsync(w.App, "dono", w.Owner, null, foreign: w.B);

        // O salto de carga é por pessoa mesmo sobre a linha COMPARTILHADA do catálogo: cada uma vê o seu, o dono vê o do equipamento.
        JsonElement StepOf(List<JsonElement> rows) => rows.Single(r => IdOf(r) == catalog).GetProperty("stepKg");
        StepOf(await RowsOfAsync(w.App, w.Alice.Login, "exercises")).GetDecimal().Should().Be(w.A.Step);
        StepOf(await RowsOfAsync(w.App, w.Bruno.Login, "exercises")).GetDecimal().Should().Be(w.B.Step);
        var ownerStep = StepOf(await RowsOfAsync(w.App, w.Owner, "exercises"));
        (ownerStep.ValueKind == JsonValueKind.Null || (ownerStep.GetDecimal() != w.A.Step && ownerStep.GetDecimal() != w.B.Step))
            .Should().BeTrue("a escolha de salto da Alice e do Bruno não vale para quem não a fez");
    }

    private static async Task AssertOnlyOwnAsync(TrainingApp app, string who, LoggedIn login, Data? mine, Data foreign)
    {
        foreach (var resource in Resources)
        {
            var pages = await app.PullAllAsync(login, resource, PullLimit);
            var rows = pages.Rows().ToList();
            var ids = rows.Select(IdOf).ToList();
            var text = string.Concat(pages.Select(p => p.GetRawText()));

            text.Should().NotContain(foreign.Secret, $"{who} lendo {resource}");
            text.Should().NotContain(foreign.Weight.ToString(System.Globalization.CultureInfo.InvariantCulture), $"{who} lendo {resource}");

            switch (resource)
            {
                case "exercises":
                    ids.Should().NotContain(foreign.ExerciseId, $"{who} lendo {resource}");
                    rows.Count(r => r.GetProperty("source").GetString() == "own").Should().Be(mine is null ? 0 : 1, $"{who}: exercícios próprios");
                    rows.Count.Should().BeGreaterThan(100, "o catálogo compartilhado continua inteiro");
                    break;
                case "routines":
                    ids.Should().Equal(mine is null ? [] : [mine.RoutineId], $"{who} lendo {resource}");
                    break;
                case "sessions":
                    ids.Should().Equal(mine is null ? [] : [mine.SessionId], $"{who} lendo {resource}");
                    break;
                case "sets":
                    ids.Should().Equal(mine is null ? [] : [mine.SetId], $"{who} lendo {resource}");
                    break;
                default:
                    ids.Should().Equal(mine is null ? [] : [mine.GoalId], $"{who} lendo {resource}");
                    break;
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Escrita: o id de outra pessoa não existe para quem chama (404), não se altera, não se apaga, não se adivinha
    // ---------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task BrunoCannotWriteOnTheIdsOfAlice_InAnyRoute_AndNothingOfHersChanges()
    {
        await using var w = await StartAsync();
        var app = w.App;
        var b = w.Bruno.Login;
        var a = w.A;
        var now = DateTimeOffset.UtcNow;
        var catalog = RoutineHelpers.CatalogId(0);

        var attempts = new (string Label, Func<Task<HttpResponseMessage>> Call)[]
        {
            ("PUT exercises/{alice}", () => app.PutCustomAsync(b, a.ExerciseId, TrainingApp.CustomBody(now, "Invadido"))),
            ("PUT exercises/{alice} apagando", () => app.PutCustomAsync(b, a.ExerciseId, TrainingApp.CustomBody(now, "Invadido", deleted: true))),
            ("PUT exercises/{alice}/step", () => app.SendAsync(
                HttpMethod.Put, $"/api/v1/training/exercises/{a.ExerciseId}/step", new { stepKg = 99m, clientUpdatedAt = now }, b.AccessToken, Guid.NewGuid())),
            ("PUT routines/{alice}", () => app.PutRoutineAsync(b, a.RoutineId, RoutineHelpers.Body(now, name: "Invadida"))),
            ("PUT routines/{alice} apagando", () => app.PutRoutineAsync(b, a.RoutineId, RoutineHelpers.Body(now, name: "Invadida", deleted: true))),
            ("PUT sessions/{alice}", () => app.PutSessionAsync(b, a.SessionId, SessionHelpers.SessionBody(now, note: "Invadido"))),
            ("PUT sessions/{alice} apagando", () => app.PutSessionAsync(b, a.SessionId, SessionHelpers.SessionBody(now, deleted: true))),
            ("PUT sessions/{alice} encerrando", () => app.PutSessionAsync(b, a.SessionId, SessionHelpers.SessionBody(now, finishedAt: now))),
            ("PUT sessions/{alice}/sets/{alice}", () => app.PutSetAsync(b, a.SessionId, a.SetId, SessionHelpers.SetBody(now, catalog, weightKg: 1m))),
            ("PUT sessions/{alice}/sets/{nova}", () => app.PutSetAsync(b, a.SessionId, Guid.CreateVersion7(), SessionHelpers.SetBody(now, catalog))),
            ("PUT sessions/{bruno}/sets/{alice}", () => app.PutSetAsync(b, w.B.SessionId, a.SetId, SessionHelpers.SetBody(now, catalog, weightKg: 1m))),
        };

        var shapes = new Dictionary<string, string>();
        foreach (var (label, call) in attempts)
        {
            using var response = await call();
            response.StatusCode.Should().Be(HttpStatusCode.NotFound, label);
            shapes[label] = await ProblemShape.OfAsync(response);
            shapes[label].Should().NotContain(a.ExerciseId.ToString()).And.NotContain(a.RoutineId.ToString())
                .And.NotContain(a.SessionId.ToString()).And.NotContain(a.SetId.ToString(), $"{label}: a resposta não repete o id");
        }

        // A recusa é a mesma de um id que não existe (onde um id novo não criaria a linha, o que tornaria a pergunta outra).
        var randomStep = await ShapeOfAsync(app.SendAsync(
            HttpMethod.Put, $"/api/v1/training/exercises/{Guid.NewGuid()}/step", new { stepKg = 1m, clientUpdatedAt = now }, b.AccessToken, Guid.NewGuid()));
        var randomSet = await ShapeOfAsync(app.PutSetAsync(b, Guid.NewGuid(), Guid.NewGuid(), SessionHelpers.SetBody(now, catalog)));
        shapes["PUT exercises/{alice}/step"].Should().Be(randomStep);
        shapes["PUT exercises/{alice}"].Should().Be(randomStep);
        shapes["PUT exercises/{alice} apagando"].Should().Be(randomStep);
        foreach (var label in attempts.Select(x => x.Label).Where(l => l.Contains("sessions/", StringComparison.Ordinal)))
        {
            shapes[label].Should().Be(randomSet, label);
        }

        // Nada de Alice mudou, e nada novo apareceu no nome do Bruno.
        await using var db = app.Db();
        var routine = await db.Set<Routine>().Include(r => r.Items).SingleAsync(r => r.Id == a.RoutineId, Ct);
        routine.UserId.Should().Be(w.Alice.UserId);
        routine.Name.Should().Be($"Rotina {a.Secret}");
        routine.DeletedAt.Should().BeNull();
        routine.Items.Should().HaveCount(2);
        var session = await db.Set<Session>().SingleAsync(s => s.Id == a.SessionId, Ct);
        session.UserId.Should().Be(w.Alice.UserId);
        session.Note.Should().Be($"Treino {a.Secret}");
        session.FinishedAt.Should().BeNull();
        session.DeletedAt.Should().BeNull();
        var set = await db.Set<SessionSet>().SingleAsync(s => s.Id == a.SetId, Ct);
        set.UserId.Should().Be(w.Alice.UserId);
        set.SessionId.Should().Be(a.SessionId);
        set.WeightKg.Should().Be(a.Weight);
        set.DeletedAt.Should().BeNull();
        var exercise = await db.Exercises.SingleAsync(e => e.Id == a.ExerciseId, Ct);
        exercise.OwnerUserId.Should().Be(w.Alice.UserId);
        exercise.Name.Should().Be($"Exercicio {a.Secret}");
        exercise.DeletedAt.Should().BeNull();
        (await db.ExerciseOverrides.CountAsync(o => o.UserId == w.Bruno.UserId && o.ExerciseId == a.ExerciseId, Ct)).Should().Be(0);
        (await db.Set<SessionSet>().CountAsync(s => s.UserId == w.Bruno.UserId, Ct)).Should().Be(1, "só a série do próprio Bruno");
        (await db.Set<Session>().CountAsync(s => s.UserId == w.Bruno.UserId, Ct)).Should().Be(1);
        (await db.Set<Routine>().CountAsync(r => r.UserId == w.Bruno.UserId, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task BrunoReferencingTheResourcesOfAlice_GetsTheSameAnswerAsReferencingNothingThatExists()
    {
        await using var w = await StartAsync();
        var app = w.App;
        var b = w.Bruno.Login;
        var a = w.A;
        var now = DateTimeOffset.UtcNow;
        var nowhere = Guid.CreateVersion7();

        var routineForeign = await ShapeOfAsync(app.PutRoutineAsync(
            b, Guid.CreateVersion7(), RoutineHelpers.Body(now, [RoutineHelpers.Item(Guid.CreateVersion7(), a.ExerciseId, 0)])));
        var routineMissing = await ShapeOfAsync(app.PutRoutineAsync(
            b, Guid.CreateVersion7(), RoutineHelpers.Body(now, [RoutineHelpers.Item(Guid.CreateVersion7(), nowhere, 0)])));
        routineForeign.Should().StartWith("422|").And.Be(routineMissing, "um exercício de outra pessoa conta como inexistente");

        var sessionForeign = await ShapeOfAsync(app.PutSessionAsync(b, Guid.CreateVersion7(), SessionHelpers.SessionBody(now, routineId: a.RoutineId)));
        var sessionMissing = await ShapeOfAsync(app.PutSessionAsync(b, Guid.CreateVersion7(), SessionHelpers.SessionBody(now, routineId: nowhere)));
        sessionForeign.Should().StartWith("422|").And.Be(sessionMissing, "uma rotina de outra pessoa conta como inexistente");

        var setForeign = await ShapeOfAsync(app.PutSetAsync(b, w.B.SessionId, Guid.CreateVersion7(), SessionHelpers.SetBody(now, a.ExerciseId)));
        var setMissing = await ShapeOfAsync(app.PutSetAsync(b, w.B.SessionId, Guid.CreateVersion7(), SessionHelpers.SetBody(now, nowhere)));
        setForeign.Should().StartWith("422|").And.Be(setMissing, "um exercício de outra pessoa conta como inexistente");

        var goalForeign = await ShapeOfAsync(app.PutGoalAsync(b, GoalKinds.ExerciseE1rm, GoalHelpers.GoalBody(now, 120m, a.ExerciseId)));
        var goalMissing = await ShapeOfAsync(app.PutGoalAsync(b, GoalKinds.ExerciseE1rm, GoalHelpers.GoalBody(now, 120m, nowhere)));
        goalForeign.Should().StartWith("422|").And.Be(goalMissing, "um exercício de outra pessoa conta como inexistente");

        // Nenhuma dessas tentativas deixou rastro.
        await using var db = app.Db();
        (await db.Set<Routine>().CountAsync(r => r.UserId == w.Bruno.UserId, Ct)).Should().Be(1);
        (await db.Set<Session>().CountAsync(s => s.UserId == w.Bruno.UserId, Ct)).Should().Be(1);
        (await db.Set<SessionSet>().CountAsync(s => s.UserId == w.Bruno.UserId, Ct)).Should().Be(1);
        (await db.Set<Goal>().CountAsync(g => g.UserId == w.Bruno.UserId, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task TheSharedCatalog_IsReadOnlyForEveryone_AndEachPersonsStepChoiceStaysTheirs()
    {
        await using var w = await StartAsync();
        var catalog = RoutineHelpers.CatalogId(0);
        var now = DateTimeOffset.UtcNow;

        foreach (var login in new[] { w.Alice.Login, w.Bruno.Login })
        {
            using var response = await w.App.PutCustomAsync(login, catalog, TrainingApp.CustomBody(now, "Catalogo editado"));
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
            (await TrainingAssertions.ProblemTypeAsync(response)).Should().EndWith("/catalog-row-readonly");
        }

        await using var db = w.App.Db();
        (await db.Exercises.SingleAsync(e => e.Id == catalog, Ct)).Name.Should().NotBe("Catalogo editado");
        var overrides = await db.ExerciseOverrides.Where(o => o.ExerciseId == catalog).ToDictionaryAsync(o => o.UserId, o => o.StepKg, Ct);
        overrides.Should().BeEquivalentTo(new Dictionary<Guid, decimal?> { [w.Alice.UserId] = w.A.Step, [w.Bruno.UserId] = w.B.Step });
    }

    [Fact]
    public async Task TwoPeople_CanUseTheSameNamesAndTheSameItemIds_WithoutCollidingOrRevealingAnything()
    {
        await using var w = await StartAsync();
        var app = w.App;
        var now = DateTimeOffset.UtcNow;
        var catalog = RoutineHelpers.CatalogId(0);

        // Mesmo nome de exercício próprio (a chave única do texto inclui o id, não só o nome).
        using var exercise = await app.PutCustomAsync(
            w.Bruno.Login, Guid.CreateVersion7(), TrainingApp.CustomBody(now, $"Exercicio {w.A.Secret}", instructions: [$"Passo {w.A.Secret}"]));
        exercise.StatusCode.Should().Be(HttpStatusCode.OK);

        // Mesmo id de item de rotina (o id do item só é único dentro da rotina).
        using var routine = await app.PutRoutineAsync(
            w.Bruno.Login,
            Guid.CreateVersion7(),
            RoutineHelpers.Body(now, [RoutineHelpers.Item(w.A.ItemId, catalog, 0)], name: $"Rotina {w.A.Secret}"));
        routine.StatusCode.Should().Be(HttpStatusCode.OK);

        // A rotina da Alice segue com os dois itens dela.
        await using var db = app.Db();
        var alices = await db.Set<Routine>().Include(r => r.Items).SingleAsync(r => r.Id == w.A.RoutineId, Ct);
        alices.Items.Should().HaveCount(2);
        alices.Items.Should().Contain(i => i.Id == w.A.ItemId && i.ExerciseId == catalog);
    }

    [Fact]
    public async Task EachPerson_HasTheirOwnOpenSession_AndTheRefusalNeverNamesTheOtherPersonsSession()
    {
        // Um aparelho por vez vale POR PESSOA: o treino aberto de Alice não impede o do Bruno (a semente já abriu os dois).
        await using var w = await StartAsync();

        using var second = await w.App.PutSessionAsync(
            w.Bruno.Login, Guid.CreateVersion7(), SessionHelpers.SessionBody(DateTimeOffset.UtcNow, deviceId: "aparelho-b"));

        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var body = await second.Content.ReadAsStringAsync(Ct);
        body.Should().Contain(w.B.SessionId.ToString(), "a recusa mostra o treino aberto do próprio Bruno");
        body.Should().NotContain(w.A.SessionId.ToString());
        await using var db = w.App.Db();
        (await db.Set<Session>().CountAsync(s => s.FinishedAt == null && s.DeletedAt == null, Ct)).Should().Be(2);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Leitura incremental: o cursor é só uma posição; nunca abre linha de outra pessoa
    // ---------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task TheCursorOfBruno_NeverReturnsRowsOfAlice_NoMatterWhereItPoints()
    {
        await using var w = await StartAsync();
        var app = w.App;
        var fromTheBeginning = new PullCursor(DateTimeOffset.UnixEpoch, Guid.Empty).Encode();

        foreach (var resource in Resources)
        {
            // Do começo dos tempos: devolve tudo o que é do Bruno e nada da Alice.
            var fromEpoch = await app.PullResourceAsync(w.Bruno.Login, resource, after: fromTheBeginning, limit: PullLimit);
            fromEpoch.StatusCode.Should().Be(HttpStatusCode.OK, resource);
            var epochIds = (await TrainingApp.JsonAsync(fromEpoch)).GetProperty("items").EnumerateArray().Select(IdOf).ToList();

            // Com o cursor da PRÓPRIA Alice (a posição da última linha dela): continua só com linhas do Bruno.
            using var alicePage = await app.PullResourceAsync(w.Alice.Login, resource, limit: PullLimit);
            var aliceCursor = (await TrainingApp.JsonAsync(alicePage)).GetProperty("nextCursor").GetString();
            using var withAlicesCursor = await app.PullResourceAsync(w.Bruno.Login, resource, after: aliceCursor, limit: PullLimit);
            withAlicesCursor.StatusCode.Should().Be(HttpStatusCode.OK, resource);
            var cursorIds = (await TrainingApp.JsonAsync(withAlicesCursor)).GetProperty("items").EnumerateArray().Select(IdOf).ToList();

            foreach (var ids in new[] { epochIds, cursorIds })
            {
                ids.Should().NotContain([w.A.ExerciseId, w.A.RoutineId, w.A.SessionId, w.A.SetId, w.A.GoalId], resource);
            }

            if (resource != "exercises")
            {
                epochIds.Should().HaveCount(1, $"{resource}: o Bruno vê só a linha dele");
            }
        }

        // Paginado de um em um (muitas páginas, cada uma com o seu cursor): ainda só o que é do Bruno.
        foreach (var resource in Resources.Where(r => r != "exercises"))
        {
            var ids = (await RowsOfAsync(app, w.Bruno.Login, resource, limit: 1)).Select(IdOf).ToList();
            ids.Should().HaveCount(1, resource);
        }
    }

    [Fact]
    public async Task ACursorMadeUp_OrDamaged_IsRefusedTheSameWay_NotAnOracleOfExistingRows()
    {
        await using var w = await StartAsync();

        // Um cursor sobre o id de uma linha da Alice (que o Bruno não deveria conhecer) é só uma posição, como qualquer outro.
        var pointingAtAlice = new PullCursor(DateTimeOffset.UtcNow.AddYears(-1), w.A.RoutineId).Encode();
        var pointingAtNothing = new PullCursor(DateTimeOffset.UtcNow.AddYears(-1), Guid.NewGuid()).Encode();

        var one = await ShapeOfAsync(w.App.PullResourceAsync(w.Bruno.Login, "routines", after: pointingAtAlice));
        var other = await ShapeOfAsync(w.App.PullResourceAsync(w.Bruno.Login, "routines", after: pointingAtNothing));

        // As duas são a mesma página, só com a rotina do Bruno: o id dentro do cursor não muda a resposta nem volta no corpo.
        one.Should().StartWith("200|");
        one.Should().Be(other);
        one.Should().NotContain(w.A.RoutineId.ToString());
        one.Should().Contain(w.B.RoutineId.ToString());

        var broken = await ShapeOfAsync(w.App.PullResourceAsync(w.Bruno.Login, "routines", after: "isto-nao-e-um-cursor"));
        broken.Should().StartWith("400|");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Idempotência: a chave é de quem a usa
    // ---------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task TheSameIdempotencyKey_UsedByTwoPeople_NeitherCollidesNorRevealsTheOther()
    {
        await using var w = await StartAsync();
        var app = w.App;
        var key = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var sameBody = GoalHelpers.GoalBody(now, 2500m);
        var otherBody = GoalHelpers.GoalBody(now, 1000m);

        // A mesma URL, a mesma chave e o MESMO corpo em duas contas: cada uma executa a sua, sem repetir a resposta da outra.
        using var alice = await app.PutGoalAsync(w.Alice.Login, GoalKinds.DailyKcal, sameBody, key);
        using var bruno = await app.PutGoalAsync(w.Bruno.Login, GoalKinds.DailyKcal, sameBody, key);
        alice.StatusCode.Should().Be(HttpStatusCode.OK);
        bruno.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(alice).Should().BeFalse();
        Replayed(bruno).Should().BeFalse("a resposta guardada é da Alice, não do Bruno");
        var aliceGoal = (await TrainingApp.JsonAsync(alice)).GetProperty("id").GetGuid();
        var brunoGoal = (await TrainingApp.JsonAsync(bruno)).GetProperty("id").GetGuid();
        brunoGoal.Should().NotBe(aliceGoal, "cada um tem a meta dele");

        // A mesma chave com OUTRO corpo noutra conta não é "chave reusada" (isso diria que a chave existe na conta alheia).
        using var owner = await app.PutGoalAsync(w.Owner, GoalKinds.DailyKcal, otherBody, key);
        owner.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(owner).Should().BeFalse();

        // E uma chave que a Alice usou numa rota serve ao Bruno em OUTRA rota: nada de "chave reusada" entre pessoas.
        var crossKey = Guid.NewGuid();
        using var aliceRoutine = await app.PutRoutineAsync(w.Alice.Login, Guid.CreateVersion7(), RoutineHelpers.Body(now, name: "Da Alice"), crossKey);
        using var brunoGoal2 = await app.PutGoalAsync(w.Bruno.Login, GoalKinds.DailyKcal, GoalHelpers.GoalBody(now, 3000m), crossKey);
        aliceRoutine.StatusCode.Should().Be(HttpStatusCode.OK);
        brunoGoal2.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(brunoGoal2).Should().BeFalse();

        // Controle: para a PRÓPRIA Alice a trava existe (outro corpo é recusado, o mesmo corpo repete a resposta guardada).
        using var reused = await app.PutGoalAsync(w.Alice.Login, GoalKinds.DailyKcal, otherBody, key);
        reused.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(reused)).Should().EndWith("/idempotency-key-reused");
        using var again = await app.PutGoalAsync(w.Alice.Login, GoalKinds.DailyKcal, sameBody, key);
        again.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(again).Should().BeTrue();
        (await TrainingApp.JsonAsync(again)).GetProperty("id").GetGuid().Should().Be(aliceGoal);

        // No banco: uma linha da chave por pessoa, cada uma com o seu dono.
        await using var db = app.Db();
        var owners = await db.Set<IdempotencyRecord>().Where(r => r.Key == key).Select(r => r.UserId).ToListAsync(Ct);
        owners.Should().BeEquivalentTo([w.Alice.UserId, w.Bruno.UserId, TrainingApp.UserIdOf(w.Owner)]);

        // E cada meta ficou no nome de quem a escreveu.
        (await db.Set<Goal>().SingleAsync(g => g.Id == aliceGoal, Ct)).UserId.Should().Be(w.Alice.UserId);
        (await db.Set<Goal>().SingleAsync(g => g.Id == brunoGoal, Ct)).UserId.Should().Be(w.Bruno.UserId);
    }

    // ---------------------------------------------------------------------------------------------------------
    // O que é compartilhado de verdade não depende de ninguém, e nada sensível vai para o log
    // ---------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task TheSharedReads_AreTheSameForEveryone_AndNeverCountOrShowTheirOwnData()
    {
        await using var w = await StartAsync();

        foreach (var url in new[] { "/api/v1/training/catalog/credits", "/api/v1/training/routine-templates" })
        {
            var texts = new List<string>();
            foreach (var login in new[] { w.Alice.Login, w.Bruno.Login, w.Owner })
            {
                using var response = await w.App.SendAsync(HttpMethod.Get, url, bearer: login.AccessToken);
                response.StatusCode.Should().Be(HttpStatusCode.OK, url);
                texts.Add(await response.Content.ReadAsStringAsync(Ct));
            }

            texts.Distinct().Should().ContainSingle(url + ": a mesma resposta para todos");
            texts[0].Should().NotContain(w.A.Secret).And.NotContain(w.B.Secret);
        }

        // Os créditos contam só o catálogo vivo, não os exercícios próprios que as duas pessoas criaram.
        using var credits = await w.App.SendAsync(HttpMethod.Get, "/api/v1/training/catalog/credits", bearer: w.Alice.Login.AccessToken);
        var sources = (await TrainingApp.JsonAsync(credits)).GetProperty("sources").EnumerateArray().Select(s => s.GetProperty("source").GetString()).ToList();
        sources.Should().NotContain("own");
    }

    [Fact]
    public async Task NothingOfThePeoplesData_GoesToTheLog_NotEvenWhileTheSqlIsLogged()
    {
        await using var w = await StartAsync(new TrainingAppOptions { CaptureSql = true });
        var now = DateTimeOffset.UtcNow;

        // Leituras, escritas recusadas e escritas aceitas: tudo passa pelo log capturado.
        (await w.App.PullResourceAsync(w.Bruno.Login, "routines")).Dispose();
        (await w.App.PutRoutineAsync(w.Bruno.Login, w.A.RoutineId, RoutineHelpers.Body(now, name: "Invadida"))).Dispose();
        (await w.App.PutSetAsync(w.Bruno.Login, w.B.SessionId, w.A.SetId, SessionHelpers.SetBody(now, RoutineHelpers.CatalogId(0), weightKg: 1m))).Dispose();

        var lines = w.App.Logs.Lines;
        lines.Should().NotBeEmpty("o log capturado tem de ter visto o SQL, senão a prova não vale");
        foreach (var secret in new[]
        {
            w.A.Secret, w.B.Secret,
            w.A.Weight.ToString(System.Globalization.CultureInfo.InvariantCulture),
            w.B.Weight.ToString(System.Globalization.CultureInfo.InvariantCulture),
            w.Alice.Login.AccessToken, w.Bruno.Login.AccessToken, w.Alice.Password, w.Bruno.Password,
        })
        {
            lines.Should().NotContain(l => l.Contains(secret, StringComparison.Ordinal), "dado de treino, saúde e credencial nunca vão ao log");
        }
    }
}
