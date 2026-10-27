using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Ports;

namespace UniOver.IntegrationTests.Training;

/// <summary>Cliente do wger de mentira: fatia uma lista fixa em páginas e pode falhar ou esperar numa chamada.</summary>
internal sealed class FakeWgerClient(IReadOnlyList<WgerExercise> items) : IWgerClient
{
    private int _calls;

    public int Calls => _calls;

    public List<int> Offsets { get; } = [];

    /// <summary>A partir desta chamada (1 = primeira) o cliente falha como se o wger tivesse caído.</summary>
    public int? FailFromCall { get; init; }

    public TaskCompletionSource? Gate { get; init; }

    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public async Task<WgerPage> GetExercisesAsync(int offset, int limit, CancellationToken cancellationToken)
    {
        var call = Interlocked.Increment(ref _calls);
        lock (Offsets)
        {
            Offsets.Add(offset);
        }

        Entered.TrySetResult();
        if (Gate is not null)
        {
            await Gate.Task.WaitAsync(cancellationToken);
        }

        if (FailFromCall is { } from && call >= from)
        {
            throw new WgerUnavailableException("O wger caiu.");
        }

        var page = items.Skip(offset).Take(limit).ToList();
        return new WgerPage(items.Count, offset + limit < items.Count, page);
    }
}

[Collection(PostgresGroup.Name)]
public sealed class WgerImportTests(PostgresFixture postgres)
{
    private const int Portuguese = 7;
    private const int English = 2;
    private const int CcBySa4 = 2;
    private const int OtherLicense = 1;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static WgerExercise Item(
        string uuid, string name, int language = Portuguese, string? author = "Ana", int license = CcBySa4,
        int[]? muscles = null, int[]? equipment = null, string description = "<p>Passo um.</p><p>Passo dois.</p>") =>
        new(uuid, muscles ?? [4], [5], equipment ?? [1], [new WgerTranslation(language, name, description, license, author)]);

    /// <summary>Sete exercícios, cada um caindo num degrau diferente do funil.</summary>
    private static WgerExercise[] Funnel() =>
    [
        Item("00000000-0000-4000-8000-000000000001", "Supino do wger"),
        Item("00000000-0000-4000-8000-000000000002", "Sem autor", author: null),
        Item("00000000-0000-4000-8000-000000000003", "Outra licença", license: OtherLicense),
        Item("00000000-0000-4000-8000-000000000004", "Only english", language: English),
        Item("00000000-0000-4000-8000-000000000005", "Sem músculo", muscles: []),
        Item("00000000-0000-4000-8000-000000000006", "SUPINO RETO COM BARRA"),
        Item("00000000-0000-4000-8000-000000000007", "Flexão do wger", muscles: [12], equipment: []),
    ];

    private static async Task<HttpResponseMessage> ImportAsync(TrainingApp app, LoggedIn? login, bool? dryRun, Guid? idempotencyKey = null)
    {
        var url = "/api/v1/training/catalog/imports/wger" + (dryRun is null ? string.Empty : $"?dryRun={dryRun.Value.ToString().ToLowerInvariant()}");
        return await app.SendAsync(HttpMethod.Post, url, bearer: login?.AccessToken, idempotencyKey: idempotencyKey ?? Guid.NewGuid());
    }

    [Fact]
    public async Task SameKey_ReplaysTheImportWithoutCallingWgerAgain()
    {
        var fake = new FakeWgerClient(Funnel());
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = fake });
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();

        using var first = await ImportAsync(app, login, false, key);
        var firstBody = await first.Content.ReadAsStringAsync(Ct);
        var callsAfterFirst = fake.Calls;
        using var replay = await ImportAsync(app, login, false, key);

        replay.StatusCode.Should().Be(HttpStatusCode.OK);
        replay.Headers.GetValues("Idempotent-Replayed").Should().ContainSingle().Which.Should().Be("true");
        (await replay.Content.ReadAsStringAsync(Ct)).Should().Be(firstBody);
        fake.Calls.Should().Be(callsAfterFirst, "a repetição recebe a resposta guardada sem iniciar outra importação");
        await using var db = app.Db();
        (await db.Exercises.CountAsync(e => e.Source == ExerciseSources.Wger, Ct)).Should().Be(2);
    }

    [Fact]
    public async Task SameKeyWithAnotherDryRunValue_Gets422()
    {
        var fake = new FakeWgerClient(Funnel());
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = fake });
        var login = await app.LoginAsync();
        var key = Guid.NewGuid();

        using var first = await ImportAsync(app, login, true, key);
        using var changed = await ImportAsync(app, login, false, key);

        first.StatusCode.Should().Be(HttpStatusCode.OK);
        changed.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await TrainingAssertions.ProblemTypeAsync(changed)).Should().EndWith("idempotency-key-reused");
        fake.Calls.Should().Be(1, "a query faz parte do pedido protegido pela chave");
    }

    [Fact]
    public async Task WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = new FakeWgerClient(Funnel()) });

        using var response = await ImportAsync(app, null, true);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task DryRun_ReportsTheFunnel_AndWritesNothing()
    {
        var fake = new FakeWgerClient(Funnel());
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = fake });
        var login = await app.LoginAsync();

        using var response = await ImportAsync(app, login, true);
        var counts = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        counts.GetProperty("dryRun").GetBoolean().Should().BeTrue();
        counts.GetProperty("scanned").GetInt32().Should().Be(7);
        counts.GetProperty("withPortuguese").GetInt32().Should().Be(6);
        counts.GetProperty("withAuthor").GetInt32().Should().Be(5);
        counts.GetProperty("withLicense").GetInt32().Should().Be(4);
        counts.GetProperty("unmappable").GetInt32().Should().Be(1);
        counts.GetProperty("duplicates").GetInt32().Should().Be(1, "o nome 'SUPINO RETO COM BARRA' já existe no catálogo (sem acento e sem caixa)");
        counts.GetProperty("alreadyImported").GetInt32().Should().Be(0);
        counts.GetProperty("importable").GetInt32().Should().Be(2);
        counts.GetProperty("imported").GetInt32().Should().Be(0);

        await using var db = app.Db();
        (await db.Exercises.CountAsync(e => e.Source == ExerciseSources.Wger, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task OmittedDryRun_MeansSimulation()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = new FakeWgerClient(Funnel()) });
        var login = await app.LoginAsync();

        using var response = await ImportAsync(app, login, null);
        var counts = await TrainingApp.JsonAsync(response);

        counts.GetProperty("dryRun").GetBoolean().Should().BeTrue();
        await using var db = app.Db();
        (await db.Exercises.CountAsync(e => e.Source == ExerciseSources.Wger, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task RealImport_OnlyBringsPortugueseWithAuthorAndTheRightLicense()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = new FakeWgerClient(Funnel()) });
        var login = await app.LoginAsync();

        using var response = await ImportAsync(app, login, false);
        var counts = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        counts.GetProperty("imported").GetInt32().Should().Be(2);
        await using var db = app.Db();
        var rows = await db.Exercises.Where(e => e.Source == ExerciseSources.Wger).OrderBy(e => e.Name).ToListAsync(Ct);
        rows.Select(r => r.Name).Should().Equal("Flexão do wger", "Supino do wger");
        foreach (var row in rows)
        {
            row.License.Should().Be("CC-BY-SA 4");
            row.LicenseAuthor.Should().Be("Ana");
            row.LicenseUrl.Should().StartWith("https://creativecommons.org/licenses/by-sa/4.0");
            row.OwnerUserId.Should().BeNull();
            row.SourceRef.Should().StartWith("00000000-0000-4000-8000-");
            row.Id.Should().Be(ExerciseIds.ForCatalog(ExerciseSources.Wger, row.SourceRef!));
            row.Reviewed.Should().BeFalse();
        }

        var bench = rows.Single(r => r.Name == "Supino do wger");
        bench.PrimaryMuscles.Should().Equal("chest");
        bench.SecondaryMuscles.Should().Equal("triceps");
        bench.Equipment.Should().Be("barbell");
        bench.Instructions.Should().Equal("Passo um.", "Passo dois.");
        var pushUp = rows.Single(r => r.Name == "Flexão do wger");
        pushUp.Equipment.Should().Be("bodyweight");
        pushUp.RecordType.Should().Be("reps_only");
    }

    [Fact]
    public async Task ImportedRows_ShowUpInThePull_AndInTheCredits()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = new FakeWgerClient(Funnel()) });
        var login = await app.LoginAsync();
        using (await ImportAsync(app, login, false))
        {
        }

        var pages = await app.PullAllPagesAsync(login, 500);
        pages.SelectMany(p => p.GetProperty("items").EnumerateArray())
            .Where(i => i.GetProperty("source").GetString() == ExerciseSources.Wger).Should().HaveCount(2);

        using var credits = await app.SendAsync(HttpMethod.Get, "/api/v1/training/catalog/credits", bearer: login.AccessToken);
        var body = await TrainingApp.JsonAsync(credits);

        credits.StatusCode.Should().Be(HttpStatusCode.OK);
        var sources = body.GetProperty("sources").EnumerateArray().ToDictionary(s => s.GetProperty("source").GetString()!, s => s.Clone());
        sources[ExerciseSources.Wger].GetProperty("count").GetInt32().Should().Be(2);
        sources[ExerciseSources.FreeExerciseDb].GetProperty("count").GetInt32().Should().Be(CatalogSeedSource.Read().Exercises.Count);
        sources[ExerciseSources.FreeExerciseDb].GetProperty("license").GetString().Should().Be("Unlicense");
        var authors = body.GetProperty("wgerAuthors").EnumerateArray().ToList();
        authors.Should().ContainSingle();
        authors[0].GetProperty("author").GetString().Should().Be("Ana");
        authors[0].GetProperty("count").GetInt32().Should().Be(2);
        authors[0].GetProperty("license").GetString().Should().Be("CC-BY-SA 4");
    }

    [Fact]
    public async Task RunningTwice_DoesNotImportTheSameExerciseAgain()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = new FakeWgerClient(Funnel()) });
        var login = await app.LoginAsync();
        using (await ImportAsync(app, login, false))
        {
        }

        using var second = await ImportAsync(app, login, false);
        var counts = await TrainingApp.JsonAsync(second);

        counts.GetProperty("alreadyImported").GetInt32().Should().Be(2);
        counts.GetProperty("importable").GetInt32().Should().Be(0);
        counts.GetProperty("imported").GetInt32().Should().Be(0);
        await using var db = app.Db();
        (await db.Exercises.CountAsync(e => e.Source == ExerciseSources.Wger, Ct)).Should().Be(2);
    }

    [Fact]
    public async Task ReadsPageByPage_RespectingThePageSizeAndTheItemCap()
    {
        var items = Enumerable.Range(0, 30)
            .Select(i => Item($"10000000-0000-4000-8000-{i:D12}", $"Exercício do wger {i}")).ToArray();
        var fake = new FakeWgerClient(items);
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = fake, PageSize = 8, MaxItems = 20 });
        var login = await app.LoginAsync();

        using var response = await ImportAsync(app, login, true);
        var counts = await TrainingApp.JsonAsync(response);

        counts.GetProperty("scanned").GetInt32().Should().Be(20, "MaxItems limita o que é lido");
        fake.Offsets.Should().Equal(0, 8, 16);
    }

    [Fact]
    public async Task WgerFailure_Returns502_ReportsThePartial_AndKeepsWhatAlreadyEntered()
    {
        var items = Enumerable.Range(0, 12)
            .Select(i => Item($"20000000-0000-4000-8000-{i:D12}", $"Parcial {i}")).ToArray();
        var fake = new FakeWgerClient(items) { FailFromCall = 2 };
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = fake, PageSize = 5 });
        var login = await app.LoginAsync();

        using var response = await ImportAsync(app, login, false);
        var problem = await TrainingApp.JsonAsync(response);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        problem.GetProperty("type").GetString().Should().EndWith("upstream-unavailable");
        problem.GetProperty("scanned").GetInt32().Should().Be(5);
        problem.GetProperty("imported").GetInt32().Should().Be(5);
        await using var db = app.Db();
        (await db.Exercises.CountAsync(e => e.Source == ExerciseSources.Wger, Ct)).Should().Be(5, "sem importação parcial silenciosa: o que entrou foi relatado");
    }

    [Fact]
    public async Task WgerFailure_InADryRun_WritesNothing()
    {
        var fake = new FakeWgerClient(Funnel()) { FailFromCall = 1 };
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = fake });
        var login = await app.LoginAsync();

        using var response = await ImportAsync(app, login, true);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        await using var db = app.Db();
        (await db.Exercises.CountAsync(e => e.Source == ExerciseSources.Wger, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task OnlyOneImportRunsAtATime_TheSecondGets409()
    {
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var fake = new FakeWgerClient(Funnel()) { Gate = gate };
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = fake });
        var login = await app.LoginAsync();

        var first = ImportAsync(app, login, true);
        await fake.Entered.Task.WaitAsync(TimeSpan.FromSeconds(30), Ct);
        using var second = await ImportAsync(app, login, true);

        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await TrainingAssertions.ProblemTypeAsync(second)).Should().EndWith("import-in-progress");
        gate.SetResult();
        using var finished = await first;
        finished.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task ImportedDescription_NeverCarriesHtml()
    {
        var items = new[] { Item("30000000-0000-4000-8000-000000000001", "Com HTML", description: "<p>Use <b>carga</b> leve.</p><script>x()</script>") };
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = new FakeWgerClient(items) });
        var login = await app.LoginAsync();

        using (await ImportAsync(app, login, false))
        {
        }

        await using var db = app.Db();
        var row = await db.Exercises.SingleAsync(e => e.Source == ExerciseSources.Wger, Ct);
        row.Instructions.Should().OnlyContain(i => !i.Contains('<', StringComparison.Ordinal) && !i.Contains('>', StringComparison.Ordinal));
        row.Instructions.Should().Contain("Use carga leve.");
    }

    [Fact]
    public async Task Credits_WithoutWger_ListOnlyTheSeedSource()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var login = await app.LoginAsync();

        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/training/catalog/credits", bearer: login.AccessToken);
        var body = await TrainingApp.JsonAsync(response);

        body.GetProperty("sources").GetArrayLength().Should().Be(1);
        body.GetProperty("wgerAuthors").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task Credits_WithoutLogin_Returns401()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        using var response = await app.SendAsync(HttpMethod.Get, "/api/v1/training/catalog/credits");

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task ResponseShape_HasEveryCountOfTheFunnel()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = new FakeWgerClient(Funnel()) });
        var login = await app.LoginAsync();

        using var response = await ImportAsync(app, login, true);
        var counts = await TrainingApp.JsonAsync(response);

        counts.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(
            ["dryRun", "scanned", "withPortuguese", "withAuthor", "withLicense", "unmappable", "alreadyImported", "duplicates", "importable", "imported"]);
        counts.ValueKind.Should().Be(JsonValueKind.Object);
    }
}
