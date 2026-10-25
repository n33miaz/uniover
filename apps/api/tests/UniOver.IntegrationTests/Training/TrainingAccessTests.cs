using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training.Routines;
using UniOver.IntegrationTests.Tv;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Training.Contracts;
using UniOver.Modules.Training.Ports;

namespace UniOver.IntegrationTests.Training;

/// <summary>
/// Quem entra no Treino: a permissão <c>module:training</c> abre as rotas de dado da própria conta e nada mais. Sem ela
/// (anônimo, convidado só da TV) é 401/403 em todas as rotas, com a mesma resposta; com ela, a TV, as pessoas e a
/// importação do catálogo seguem fechadas. A permissão vem do mesmo caminho da TV (banco com cache curto, nunca o JWT), então
/// uma troca ou revogação vale em até 30 s, ou na hora quando passa pela API.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TrainingAccessTests(PostgresFixture postgres)
{
    private static readonly string[] TrainingOnly = ["module:training"];
    private static readonly string[] TvOnly = ["module:tv", "tv:control"];
    private static readonly string[] TvAndTraining = ["module:tv", "module:training"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Task<HttpResponseMessage> CallAsync(TrainingApp app, string method, string url, object? body, string? bearer) =>
        app.SendAsync(new HttpMethod(method), url, body, bearer, method == "GET" ? null : Guid.NewGuid());

    private static async Task<HttpStatusCode> StatusAsync(TrainingApp app, string url, string? bearer)
    {
        using var response = await app.SendAsync(HttpMethod.Get, url, bearer: bearer);
        return response.StatusCode;
    }

    private static FakeWgerClient OneExerciseWger() => new(
    [
        new WgerExercise(
            "00000000-0000-4000-8000-0000000000a1", [4], [5], [1],
            [new WgerTranslation(7, "Supino do wger", "<p>Passo um.</p><p>Passo dois.</p>", 2, "Ana")]),
    ]);

    private static async Task ExecuteIdentitySqlAsync(TrainingApp app, string sql)
    {
        await using var db = IdentityApp.CreateContext(app.Database.OwnerConnection);
        await db.Database.ExecuteSqlRawAsync(sql, Ct);
    }

    [Fact]
    public async Task Anonymous_Gets401_OnEveryTrainingRoute()
    {
        await using var app = await TrainingApp.StartAsync(postgres);

        foreach (var (method, pattern, url, body) in TrainingPermissionMap.AllCalls())
        {
            using var response = await CallAsync(app, method, url, body, bearer: null);
            response.StatusCode.Should().Be(HttpStatusCode.Unauthorized, $"{method} {pattern}");
        }
    }

    [Fact]
    public async Task ATvOnlyGuest_Gets403_OnEveryTrainingRoute_WithTheSameAnswerEverywhere()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = OneExerciseWger() });
        var tvGuest = await app.NewGuestAsync("So TV", TvOnly, 41);
        var trainingMember = await app.NewGuestAsync("Raphael", TrainingOnly, 42);

        var shapes = new List<string>();
        foreach (var (method, pattern, url, body) in TrainingPermissionMap.AllCalls())
        {
            using var response = await CallAsync(app, method, url, body, tvGuest.Login.AccessToken);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"{method} {pattern} para quem só tem a TV");
            shapes.Add(await ProblemShape.OfAsync(response));
        }

        // A recusa não diz qual rota, nem se o id existe, nem qual permissão faltou: é a mesma em todas.
        shapes.Distinct().Should().ContainSingle();

        // E a importação recusada a quem tem o Treino (permissão certa, rota de dado global) é igual à recusa de quem não tem nada.
        using var import = await CallAsync(app, "POST", "/api/v1/training/catalog/imports/wger", null, trainingMember.Login.AccessToken);
        import.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await ProblemShape.OfAsync(import)).Should().Be(shapes[0]);
    }

    [Fact]
    public async Task ATrainingOnlyMember_ReachesEveryTrainingRoute_ExceptTheCatalogImport()
    {
        var wger = OneExerciseWger();
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Wger = wger });
        var member = await app.NewGuestAsync("Raphael", TrainingOnly, 43);

        foreach (var route in TrainingPermissionMap.Routes)
        {
            using var response = await CallAsync(app, route.Method, route.Url(), route.Body, member.Login.AccessToken);
            TrainingPermissionMap.Reached(response.StatusCode).Should().BeTrue($"{route} para quem tem o Treino (respondeu {(int)response.StatusCode})");
        }

        // A importação grava o catálogo de todos: recusada ANTES de qualquer trabalho (o cliente do wger nunca é chamado).
        foreach (var admin in TrainingPermissionMap.AdminRoutes)
        {
            using var response = await CallAsync(app, admin.Method, admin.Url() + "?dryRun=false", admin.Body, member.Login.AccessToken);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"{admin} para quem só tem o Treino");
        }

        wger.Calls.Should().Be(0, "a recusa vem antes de consultar o wger");
        await using (var db = app.Db())
        {
            (await db.Exercises.CountAsync(e => e.Source == ExerciseSources.Wger, Ct)).Should().Be(0, "nada foi importado");
        }

        // O administrador continua alcançando a importação (a mesma rota, com o cliente de mentira).
        var owner = await app.LoginAsync();
        using var asOwner = await app.SendAsync(HttpMethod.Post, "/api/v1/training/catalog/imports/wger?dryRun=false", bearer: owner.AccessToken);
        asOwner.StatusCode.Should().Be(HttpStatusCode.OK);
        wger.Calls.Should().BeGreaterThan(0);
        await using var after = app.Db();
        (await after.Exercises.CountAsync(e => e.Source == ExerciseSources.Wger, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ATrainingOnlyMember_IsRefusedOnTheTv_OnThePeopleRoutes_AndOnTheDevices()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var member = await app.NewGuestAsync("Raphael", TrainingOnly, 44);
        var token = member.Login.AccessToken;

        var forbidden = new List<(string Method, string Url, object? Body)>();
        forbidden.AddRange(TvPermissionMap.Routes.Where(r => !r.IsStream).Select(r => (r.Method, r.Url(), r.Body)));
        forbidden.AddRange(TvPermissionMap.AdminRoutes.Select(r => (r.Method, r.Url(), r.Body)));
        forbidden.AddRange(
        [
            ("GET", "/api/v1/identity/guests", null),
            ("GET", "/api/v1/identity/guest-invites", null),
            ("POST", "/api/v1/identity/guest-invites", new { displayName = "Outra", permissions = TrainingOnly }),
            ("PUT", $"/api/v1/identity/guests/{member.UserId}/permissions", new { permissions = TvAndTraining }),
            ("POST", $"/api/v1/identity/guests/{member.UserId}/revoke", null),
            ("GET", "/api/v1/identity/passkeys", null),
            ("GET", "/api/v1/devices/agents", null),
        ]);
        foreach (var (method, url, body) in forbidden)
        {
            using var response = await CallAsync(app, method, url, body, token);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"{method} {url} para quem só tem o Treino");
        }

        // O fluxo ao vivo da TV: o bilhete do membro abre a sessão dele, mas a TV recusa.
        using var ticket = await app.SendAsync(HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: token);
        ticket.StatusCode.Should().Be(HttpStatusCode.OK);
        using var events = new HttpRequestMessage(HttpMethod.Get, "/api/v1/tv/events");
        events.Headers.Add("Cookie", $"uo_st={IdentityApp.Cookies(ticket).Single(c => c.Name == "uo_st").Value}");
        using var stream = await app.Client.SendAsync(events, HttpCompletionOption.ResponseHeadersRead, Ct);
        stream.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // O que ele tem é o Treino e o próprio perfil.
        (await StatusAsync(app, "/api/v1/training/routines", token)).Should().Be(HttpStatusCode.OK);
        (await StatusAsync(app, "/api/v1/identity/me", token)).Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AMemberWithBothModules_ReachesTheTrainingToo()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var member = await app.NewGuestAsync("Raphael", TvAndTraining, 45);

        (await StatusAsync(app, "/api/v1/training/routines", member.Login.AccessToken)).Should().Be(HttpStatusCode.OK);
        (await StatusAsync(app, "/api/v1/training/goals", member.Login.AccessToken)).Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AChangeMadeBehindTheCache_ReachesTheTraining_WithinThirtySeconds_NotBefore()
    {
        // Outra instância mudou o banco sem passar pela invalidação desta: vale o cache de 30 s do mesmo IAccessGrants da TV.
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { FakeClock = true });
        var guest = await app.NewGuestAsync("Alice", TvOnly, 46);
        var token = guest.Login.AccessToken;
        (await StatusAsync(app, "/api/v1/training/routines", token)).Should().Be(HttpStatusCode.Forbidden, "o cache já tem a conta, sem o Treino");

        await ExecuteIdentitySqlAsync(app, $"DELETE FROM identity.user_grants WHERE user_id = '{guest.UserId}'");
        await ExecuteIdentitySqlAsync(app, $"INSERT INTO identity.user_grants (user_id, permission, granted_by, granted_at) VALUES ('{guest.UserId}', 'module:training', '{guest.UserId}', now())");

        app.Time!.Advance(TimeSpan.FromSeconds(29));
        (await StatusAsync(app, "/api/v1/training/routines", token)).Should().Be(HttpStatusCode.Forbidden, "dentro do prazo vale a resposta guardada");
        app.Time.Advance(TimeSpan.FromSeconds(2));
        (await StatusAsync(app, "/api/v1/training/routines", token)).Should().Be(HttpStatusCode.OK, "passados 30 s o banco é lido de novo");

        // E o caminho inverso: retirar o Treino também vale em até 30 s.
        await ExecuteIdentitySqlAsync(app, $"DELETE FROM identity.user_grants WHERE user_id = '{guest.UserId}'");
        await ExecuteIdentitySqlAsync(app, $"INSERT INTO identity.user_grants (user_id, permission, granted_by, granted_at) VALUES ('{guest.UserId}', 'module:tv', '{guest.UserId}', now())");

        app.Time.Advance(TimeSpan.FromSeconds(29));
        (await StatusAsync(app, "/api/v1/training/routines", token)).Should().Be(HttpStatusCode.OK, "a retirada ainda não passou do prazo do cache");
        app.Time.Advance(TimeSpan.FromSeconds(2));
        (await StatusAsync(app, "/api/v1/training/routines", token)).Should().Be(HttpStatusCode.Forbidden, "passados 30 s a retirada vale, com o mesmo JWT");
    }

    [Fact]
    public async Task ARevocationMadeBehindTheCache_ClosesTheTraining_WithinThirtySeconds()
    {
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { FakeClock = true });
        var member = await app.NewGuestAsync("Raphael", TrainingOnly, 47);
        (await StatusAsync(app, "/api/v1/training/routines", member.Login.AccessToken)).Should().Be(HttpStatusCode.OK);

        await ExecuteIdentitySqlAsync(app, $"UPDATE identity.users SET disabled_at = now() WHERE id = '{member.UserId}'");

        app.Time!.Advance(TimeSpan.FromSeconds(29));
        (await StatusAsync(app, "/api/v1/training/routines", member.Login.AccessToken)).Should().Be(HttpStatusCode.OK, "ainda dentro do prazo do cache");
        app.Time.Advance(TimeSpan.FromSeconds(2));
        (await StatusAsync(app, "/api/v1/training/routines", member.Login.AccessToken)).Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task RevokingTheMemberThroughTheApi_ClosesTheTraining_AtOnce_AndLeavesTheOwnerAlone()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var member = await app.NewGuestAsync("Raphael", TrainingOnly, 48);
        (await StatusAsync(app, "/api/v1/training/routines", member.Login.AccessToken)).Should().Be(HttpStatusCode.OK);

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{member.UserId}/revoke", bearer: owner.AccessToken);

        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await StatusAsync(app, "/api/v1/training/routines", member.Login.AccessToken)).Should().Be(HttpStatusCode.Forbidden);
        (await StatusAsync(app, "/api/v1/training/routines", owner.AccessToken)).Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AChangeMadeThroughTheApi_TakesEffectOnTheTrainingAtOnce_WithTheSameJwt()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterPasskeyAsync(owner, authenticator);
        var member = await app.NewGuestAsync("Raphael", TrainingOnly, 49);
        var token = member.Login.AccessToken;
        (await StatusAsync(app, "/api/v1/training/routines", token)).Should().Be(HttpStatusCode.OK, "o cache já tem a conta");

        async Task<HttpStatusCode> ChangeAsync(string[] permissions)
        {
            await app.ConfirmAsync(owner, authenticator, StepUpActions.PermissionsChange);
            using var response = await app.SendAsync(
                HttpMethod.Put, $"/api/v1/identity/guests/{member.UserId}/permissions", new { permissions }, owner.AccessToken);
            return response.StatusCode;
        }

        (await ChangeAsync(["module:tv"])).Should().Be(HttpStatusCode.OK);
        (await StatusAsync(app, "/api/v1/training/routines", token)).Should().Be(HttpStatusCode.Forbidden, "o Treino foi retirado e o cache esquecido");

        (await ChangeAsync(TvAndTraining)).Should().Be(HttpStatusCode.OK);
        (await StatusAsync(app, "/api/v1/training/routines", token)).Should().Be(HttpStatusCode.OK, "a nova permissão vale sem esperar o prazo");
    }

    [Fact]
    public async Task EndToEnd_TheOwnerInvitesAPersonForTheTrainingOnly_WhoUsesItAndReachesNothingElse()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterPasskeyAsync(owner, authenticator);

        // O administrador cria o convite "Só o Treino" (com a confirmação por passkey que a rota exige).
        await app.ConfirmAsync(owner, authenticator, StepUpActions.GuestInvite);
        using var created = await app.SendAsync(
            HttpMethod.Post, "/api/v1/identity/guest-invites", new { displayName = "Raphael", permissions = TrainingOnly }, owner.AccessToken);
        created.StatusCode.Should().Be(HttpStatusCode.OK);
        var invite = await TrainingApp.JsonAsync(created);
        invite.GetProperty("permissions").EnumerateArray().Select(p => p.GetString()).Should().Equal(TrainingOnly);

        // A pessoa aceita o convite e passa a ser uma conta de convidado só com o Treino.
        var raphael = await app.AcceptInviteAsync(invite.GetProperty("token").GetString()!, 50);
        var token = raphael.Login.AccessToken;
        using var me = await app.SendAsync(HttpMethod.Get, "/api/v1/identity/me", bearer: token);
        me.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TrainingApp.JsonAsync(me)).GetProperty("permissions").EnumerateArray().Select(p => p.GetString()).Should().Equal(TrainingOnly);

        // Ela usa o Treino de verdade: cria uma rotina e a lê de volta.
        var routineId = Guid.CreateVersion7();
        using var put = await app.PutRoutineAsync(
            raphael.Login, routineId, RoutineHelpers.Body(DateTimeOffset.UtcNow, name: "Treino A do Raphael"));
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        using var pull = await app.PullRoutinesAsync(raphael.Login);
        pull.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TrainingApp.JsonAsync(pull)).GetProperty("items").EnumerateArray()
            .Select(r => r.GetProperty("id").GetGuid()).Should().Equal(routineId);

        // E não chama a TV, nem as rotas de pessoas (convites, permissões, sessões de outros), nem os aparelhos, nem a importação.
        foreach (var (method, url, body) in new (string, string, object?)[]
        {
            ("GET", "/api/v1/tv/state", null),
            ("POST", "/api/v1/tv/keys", new { key = "HOME" }),
            ("POST", "/api/v1/tv/power/off", null),
            ("GET", "/api/v1/tv/config", null),
            ("GET", "/api/v1/identity/guests", null),
            ("GET", "/api/v1/identity/guest-invites", null),
            ("POST", "/api/v1/identity/guest-invites", new { displayName = "Outro", permissions = TrainingOnly }),
            ("PUT", $"/api/v1/identity/guests/{raphael.UserId}/permissions", new { permissions = TvAndTraining }),
            ("GET", "/api/v1/identity/passkeys", null),
            ("GET", "/api/v1/devices/agents", null),
            ("POST", "/api/v1/training/catalog/imports/wger?dryRun=true", null),
        })
        {
            using var response = await CallAsync(app, method, url, body, token);
            response.StatusCode.Should().Be(HttpStatusCode.Forbidden, $"{method} {url}");
        }

        // A rotina dela é dela: o administrador não a enxerga na própria leitura.
        using var ownerPull = await app.PullRoutinesAsync(owner);
        (await TrainingApp.JsonAsync(ownerPull)).GetProperty("items").GetArrayLength().Should().Be(0);
    }
}
