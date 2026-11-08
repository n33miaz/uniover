using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.InstallHint;
using UniOver.Modules.Identity.Persistence;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Identity;

/// <summary>
/// A resposta da conta à dica "adicionar à tela de início": tabela própria, fusão que nunca desfaz uma resposta, só o
/// dono da conta lê e grava a sua, e nada disso encosta nas preferências da Início (versão e conflito). Host real,
/// Postgres real.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class InstallHintTests(PostgresFixture postgres)
{
    private const string Route = "/api/v1/identity/me/install-hint";
    private const string PreferencesRoute = "/api/v1/identity/me/preferences";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Task<HttpResponseMessage> PutHintAsync(IdentityApp app, string token, object? body) =>
        app.SendAsync(HttpMethod.Put, Route, body, bearer: token);

    private static Task<HttpResponseMessage> PutHomeAsync(IdentityApp app, string token, int baseVersion, params string[] ids) =>
        app.SendAsync(
            HttpMethod.Put, PreferencesRoute,
            new { baseVersion, home = ids.Select(id => new { id, enabled = true }).ToArray() }, bearer: token);

    [Fact]
    public async Task Anonymous_IsRefused_OnReadAndWrite()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        using var read = await app.GetAsync(Route);
        using var write = await app.SendAsync(HttpMethod.Put, Route, new { scopes = new { root = new { never = true } } });

        read.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        write.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task AccountThatNeverAnswered_ReadsAnEmptyObject()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await app.GetAsync(Route, owner.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await IdentityApp.JsonAsync(response)).EnumerateObject().Should().BeEmpty();
    }

    [Fact]
    public async Task Answer_IsReadBack_InItsOwnTable_AndPreferencesStayUntouched()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var save = await PutHintAsync(app, owner.AccessToken, new { scopes = new { root = new { never = true }, tv = new { dismissedAt = 1_000L } } });
        save.StatusCode.Should().Be(HttpStatusCode.OK);

        using var read = await app.GetAsync(Route, owner.AccessToken);
        var body = await IdentityApp.JsonAsync(read);
        body.GetProperty("root").GetProperty("never").GetBoolean().Should().BeTrue();
        body.GetProperty("tv").GetProperty("dismissedAt").GetInt64().Should().Be(1_000L);

        // A Início não tem nenhuma linha: nunca gravada, versão zero, e o corpo não ganhou campo novo.
        using var preferences = await app.GetAsync(PreferencesRoute, owner.AccessToken);
        var prefs = await IdentityApp.JsonAsync(preferences);
        prefs.GetProperty("version").GetInt32().Should().Be(0);
        prefs.TryGetProperty("installHint", out _).Should().BeFalse();
        await using var db = app.Db();
        (await db.AccountPreferences.CountAsync(Ct)).Should().Be(0);
        (await db.InstallHintAnswers.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Installed_IsAFactOfTheDevice_NeverStoredNorReturned()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var save = await PutHintAsync(app, owner.AccessToken, new { scopes = new { root = new { installed = true, never = true }, tv = new { installed = true } } });

        save.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(save);
        body.GetProperty("root").TryGetProperty("installed", out _).Should().BeFalse();
        body.GetProperty("tv").TryGetProperty("installed", out _).Should().BeFalse();
        body.GetProperty("root").GetProperty("never").GetBoolean().Should().BeTrue();
        await using var db = app.Db();
        (await db.InstallHintAnswers.SingleAsync(Ct)).AnswersJson.Should().NotContain("installed");
        using var read = await app.GetAsync(Route, owner.AccessToken);
        (await IdentityApp.JsonAsync(read)).GetProperty("root").TryGetProperty("installed", out _).Should().BeFalse();
    }

    [Fact]
    public async Task Merge_NeverUndoesAnAnswer()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var first = await PutHintAsync(app, owner.AccessToken, new { scopes = new { root = new { never = true, dismissedAt = 5_000L } } });
        first.StatusCode.Should().Be(HttpStatusCode.OK);

        // Um aparelho de memória apagada manda "nunca" desligado e um "Agora não" mais antigo: nada que valia se desfaz.
        using var second = await PutHintAsync(app, owner.AccessToken, new { scopes = new { root = new { never = false, dismissedAt = 2_000L }, treino = new { never = true } } });
        second.StatusCode.Should().Be(HttpStatusCode.OK);

        var merged = await IdentityApp.JsonAsync(second);
        merged.GetProperty("root").GetProperty("never").GetBoolean().Should().BeTrue();
        merged.GetProperty("root").GetProperty("dismissedAt").GetInt64().Should().Be(5_000L);
        merged.GetProperty("treino").GetProperty("never").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task DismissedAt_InTheFuture_IsCappedAtNowPlusOneDay()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var ceiling = app.Time.GetUtcNow().AddDays(1).ToUnixTimeMilliseconds();

        using var save = await PutHintAsync(app, owner.AccessToken, new { scopes = new { root = new { dismissedAt = ceiling + 400L * 24 * 60 * 60 * 1000 } } });

        save.StatusCode.Should().Be(HttpStatusCode.OK);
        (await IdentityApp.JsonAsync(save)).GetProperty("root").GetProperty("dismissedAt").GetInt64().Should().Be(ceiling);
    }

    [Fact]
    public async Task HintThenFirstHomeSave_AtVersionZero_IsNotAConflict_AndTheHomeIsKept()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var hint = await PutHintAsync(app, owner.AccessToken, new { scopes = new { root = new { never = true } } });
        hint.StatusCode.Should().Be(HttpStatusCode.OK);

        // O aparelho nunca gravou a Início (versão zero): a primeira gravação vence, sem 409 que apagaria a personalização local.
        using var save = await PutHomeAsync(app, owner.AccessToken, 0, "training", "tv");

        save.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(save);
        body.GetProperty("version").GetInt32().Should().Be(1);
        body.GetProperty("home").EnumerateArray().Select(e => e.GetProperty("id").GetString()).Should().Equal("training", "tv");
    }

    /// <summary>A política `profile` deixa 10 gravações por minuto por conta: os testes de concorrência ficam abaixo disso, senão um 429 se passaria por falha da fusão.</summary>
    private const int UnderProfileLimit = 7;

    [Fact]
    public async Task HintsAndFirstHomeSaves_AtTheSameTime_NeverConflictTheHome()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        // A corrida do relato: várias respostas da dica chegando enquanto o aparelho faz a primeira gravação da Início.
        var hints = Enumerable.Range(0, UnderProfileLimit - 1).Select(async i =>
        {
            using var response = await PutHintAsync(app, owner.AccessToken, new { scopes = new Dictionary<string, object> { [$"app{i}"] = new { never = true } } });
            return response.StatusCode;
        });
        var home = Task.Run(async () =>
        {
            using var response = await PutHomeAsync(app, owner.AccessToken, 0, "training");
            return response.StatusCode;
        });

        var results = await Task.WhenAll(hints.Append(home));

        results.Should().AllSatisfy(status => status.Should().Be(HttpStatusCode.OK));
        using var read = await app.GetAsync(PreferencesRoute, owner.AccessToken);
        var prefs = await IdentityApp.JsonAsync(read);
        prefs.GetProperty("version").GetInt32().Should().Be(1);
        prefs.GetProperty("home").EnumerateArray().Select(e => e.GetProperty("id").GetString()).Should().Equal("training");
    }

    [Fact]
    public async Task ConcurrentAnswers_SerializedByTheAccountLock_NeverFail_AndAllOfThemEndUpStored()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        var results = await Task.WhenAll(
            Enumerable.Range(0, UnderProfileLimit).Select(async i =>
            {
                using var response = await PutHintAsync(app, owner.AccessToken, new { scopes = new Dictionary<string, object> { [$"app{i}"] = new { dismissedAt = 1_000L + i } } });
                return response.StatusCode;
            }));

        results.Should().AllSatisfy(status => status.Should().Be(HttpStatusCode.OK));
        using var read = await app.GetAsync(Route, owner.AccessToken);
        (await IdentityApp.JsonAsync(read)).EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo(Enumerable.Range(0, UnderProfileLimit).Select(i => $"app{i}"));
        await using var db = app.Db();
        (await db.InstallHintAnswers.CountAsync(Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ARevokedGuest_CannotWrite()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke", bearer: owner.AccessToken);
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var write = await PutHintAsync(app, guest.Login.AccessToken, new { scopes = new { root = new { never = true } } });

        write.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task AnotherAccount_NeverSeesNorTouchesTheFirstOnes()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var save = await PutHintAsync(app, owner.AccessToken, new { scopes = new { root = new { never = true } } });
        save.StatusCode.Should().Be(HttpStatusCode.OK);

        using var guestRead = await app.GetAsync(Route, guest.Login.AccessToken);
        using var guestWrite = await PutHintAsync(app, guest.Login.AccessToken, new { scopes = new { tv = new { never = true } } });

        (await IdentityApp.JsonAsync(guestRead)).EnumerateObject().Should().BeEmpty();
        var guestNow = await IdentityApp.JsonAsync(guestWrite);
        guestNow.TryGetProperty("root", out _).Should().BeFalse();
        using var ownerRead = await app.GetAsync(Route, owner.AccessToken);
        var ownerNow = await IdentityApp.JsonAsync(ownerRead);
        ownerNow.TryGetProperty("tv", out _).Should().BeFalse();
        ownerNow.GetProperty("root").GetProperty("never").GetBoolean().Should().BeTrue();
    }

    public static TheoryData<string, object?> InvalidBodies => new()
    {
        { "sem corpo", null },
        { "sem apps", new { } },
        { "app em maiúsculas", new { scopes = new Dictionary<string, object> { ["TV"] = new { never = true } } } },
        { "app com barra", new { scopes = new Dictionary<string, object> { ["tv/x"] = new { never = true } } } },
        { "app sem resposta", new { scopes = new Dictionary<string, object?> { ["tv"] = null } } },
        { "instante negativo", new { scopes = new { root = new { dismissedAt = -1L } } } },
        { "apps demais", new { scopes = Enumerable.Range(0, 9).ToDictionary(i => $"app{i}", _ => (object)new { never = true }) } },
    };

    [Theory]
    [MemberData(nameof(InvalidBodies))]
    public async Task InvalidBody_Is400_AndNothingIsStored(string reason, object? body)
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        using var response = await PutHintAsync(app, owner.AccessToken, body);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest, reason);
        await using var db = app.Db();
        (await db.InstallHintAnswers.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task MergeBeyondTheLimit_Is400_AndKeepsWhatWasThere()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var first = await PutHintAsync(app, owner.AccessToken, new { scopes = Enumerable.Range(0, 8).ToDictionary(i => $"app{i}", _ => (object)new { never = true }) });
        first.StatusCode.Should().Be(HttpStatusCode.OK);

        using var over = await PutHintAsync(app, owner.AccessToken, new { scopes = new { extra = new { never = true } } });

        over.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        using var read = await app.GetAsync(Route, owner.AccessToken);
        (await IdentityApp.JsonAsync(read)).EnumerateObject().Should().HaveCount(8);
    }

    [Fact]
    public async Task DeletingTheAccount_TakesTheAnswersAlong()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var guest = await GuestSeed.CreateGuestAsync(app.Client, app.Database, app.Time.GetUtcNow());
        using var save = await PutHintAsync(app, guest.Login.AccessToken, new { scopes = new { root = new { never = true } } });
        save.StatusCode.Should().Be(HttpStatusCode.OK);

        await using (var db = app.Db())
        {
            await db.Database.ExecuteSqlInterpolatedAsync($"DELETE FROM identity.users WHERE id = {guest.UserId}", Ct);
        }

        await using var check = app.Db();
        (await check.InstallHintAnswers.CountAsync(Ct)).Should().Be(0);
    }

    /// <summary>
    /// A criação da linha perde a corrida: no meio da gravação, outra conexão (sem passar pela trava, como faria uma
    /// instância antiga ou um script) cria a linha da conta. O handler tem de tratar a violação de chave única, refazer a
    /// fusão sobre a linha que apareceu e devolver as duas respostas, sem erro. Teste direto no handler, com um
    /// interceptador que provoca a corrida de verdade.
    /// </summary>
    [Fact]
    public async Task LosingTheRaceToCreateTheRow_MergesOverTheWinner_InsteadOfFailing()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        _ = await app.LoginAsync();
        Guid userId;
        await using (var db = app.Db())
        {
            userId = await db.Users.Select(u => u.Id).SingleAsync(Ct);
        }

        var racer = new RowCreatedByAnotherConnection(app, userId);
        var builder = new DbContextOptionsBuilder<IdentityDbContext>();
        ModuleDatabase.Configure(builder, app.Database.OwnerConnection, IdentityDbContext.SchemaName, typeof(IdentityDbContext).Assembly);
        builder.AddInterceptors(racer);
        await using var context = new IdentityDbContext(builder.Options);
        var handler = new InstallHintHandler(context, app.Time);

        var merged = await handler.MergeAsync(
            userId, new Dictionary<string, InstallHintScope?> { ["tv"] = new InstallHintScope(null, true) }, Ct);

        racer.Fired.Should().Be(2, "a primeira gravação perdeu a corrida e foi refeita uma vez");
        merged.Should().NotBeNull();
        merged!["root"].Never.Should().BeTrue("a resposta do vencedor da corrida continua valendo");
        merged["tv"].Never.Should().BeTrue("e a nossa foi fundida por cima");
        await using var check = app.Db();
        (await check.InstallHintAnswers.CountAsync(Ct)).Should().Be(1);
    }

    /// <summary>Na primeira gravação, cria por outra conexão a linha da conta que a gravação em curso também ia criar.</summary>
    private sealed class RowCreatedByAnotherConnection(IdentityApp app, Guid userId) : SaveChangesInterceptor
    {
        public int Fired { get; private set; }

        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Fired++ == 0)
            {
                await using var other = app.Db();
                other.InstallHintAnswers.Add(InstallHintAnswers.Create(
                    userId, "{\"root\":{\"never\":true}}", app.Time.GetUtcNow()));
                await other.SaveChangesAsync(cancellationToken);
            }

            return result;
        }
    }
}
