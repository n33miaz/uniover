using System.Net;
using System.Net.Http.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// A TV padrão do dono deixa de ser o padrão de toda conta sem filiação. Só a segue a conta antiga (marca gravada pela migration
/// do Identity) e a conta que ganhou o módulo da TV (aviso da outbox do Identity, que o módulo TV transforma em marca). A conta
/// nova sem nada disso não vê TV nenhuma e recebe 404 nas rotas da TV padrão, como para uma TV que não existe.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TvDefaultForNewAccountsTests(PostgresFixture postgres)
{
    private const string OldEmail = "antiga@uniover.test";

    private static readonly Guid OldId = Guid.Parse("0192f1e4-0000-7000-8000-0000000000b7");

    private static readonly string OldPassword = "antiga-" + Guid.NewGuid().ToString("N");

    private static readonly string[] OnlyTraining = ["module:training"];

    private static readonly string[] TrainingAndTv = ["module:training", "module:tv", "tv:control"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<Guid> DefaultTvIdAsync(TvApp app)
    {
        await using var db = app.Db();
        return await db.Tvs.AsNoTracking().Where(t => t.IsDefault).Select(t => t.Id).SingleAsync(Ct);
    }

    private static async Task<List<Guid>> VisibleTvsAsync(TvApp app, string bearer)
    {
        using var response = await app.GetAsync("/api/v1/tv/tvs", bearer: bearer);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return [.. (await TvApp.JsonAsync(response)).GetProperty("items").EnumerateArray().Select(item => item.GetProperty("id").GetGuid())];
    }

    /// <summary>A rota chegou à TV: nem recusa de permissão nem o 404 de uma TV que a conta não vê.</summary>
    private static bool ReachedTheTv(HttpStatusCode status) => TvPermissionMap.Reached(status) && status != HttpStatusCode.NotFound;

    private static async Task<bool> PredatesModuleInvitesAsync(TvApp app, Guid userId)
    {
        await using var db = app.Identity();
        return await db.Users.Where(u => u.Id == userId).Select(u => u.PredatesModuleInvites).SingleAsync(Ct);
    }

    private static async Task<bool> FollowsDefaultAsync(TvApp app, Guid userId)
    {
        await using var db = app.Db();
        return await db.TvDefaultFollowers.AnyAsync(f => f.UserId == userId, Ct);
    }

    [Fact]
    public async Task AcceptingAnInviteWithTheTv_FollowsTheDefaultTv_ButTheAccountIsNotOld()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var defaultTvId = await DefaultTvIdAsync(app);

        var guest = await app.NewGuestAsync("Nova", null, 71);

        // O EF tem de gravar o false de verdade: se a coluna caísse no padrão do banco (true), toda conta nova seria antiga.
        (await PredatesModuleInvitesAsync(app, guest.UserId)).Should().BeFalse();
        (await FollowsDefaultAsync(app, guest.UserId)).Should().BeTrue("o aceite com o módulo da TV avisa o módulo TV pela outbox");

        (await VisibleTvsAsync(app, guest.Login.AccessToken)).Should().Equal(defaultTvId);
        using var state = await app.GetAsync($"/api/v1/tv/state?tvId={defaultTvId}", bearer: guest.Login.AccessToken);
        ReachedTheTv(state.StatusCode).Should().BeTrue();
    }

    [Fact]
    public async Task NewAccountWithoutTheMark_SeesNoTv_AndTheDefaultTvAnswers404()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var defaultTvId = await DefaultTvIdAsync(app);
        var guest = await app.NewGuestAsync("Sem marca", null, 72);

        // O instante antes de o aviso chegar (ou uma conta que nunca recebeu o módulo): sem filiação, sem marca, e não é antiga.
        await using (var db = app.Db())
        {
            await db.TvDefaultFollowers.Where(f => f.UserId == guest.UserId).ExecuteDeleteAsync(Ct);
        }

        (await VisibleTvsAsync(app, guest.Login.AccessToken)).Should().BeEmpty();

        using var byId = await app.GetAsync($"/api/v1/tv/state?tvId={defaultTvId}", bearer: guest.Login.AccessToken);
        using var withoutId = await app.GetAsync("/api/v1/tv/state", bearer: guest.Login.AccessToken);
        using var key = await app.SendAsync(HttpMethod.Post, $"/api/v1/tv/keys?tvId={defaultTvId}", new { key = "HOME" }, guest.Login.AccessToken);
        foreach (var response in new[] { byId, withoutId, key })
        {
            response.StatusCode.Should().Be(HttpStatusCode.NotFound, "a TV do dono não pode ser distinguida de uma TV que não existe");
        }

        // O dono continua vendo e controlando a TV padrão.
        using var owner = await app.GetAsync($"/api/v1/tv/state?tvId={defaultTvId}");
        ReachedTheTv(owner.StatusCode).Should().BeTrue();
    }

    [Fact]
    public async Task InviteWithoutTheTv_GivesNoTv_UntilTheOwnerAddsTheModule()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var defaultTvId = await DefaultTvIdAsync(app);
        var guest = await app.NewGuestAsync("Treino", OnlyTraining, 73);

        (await FollowsDefaultAsync(app, guest.UserId)).Should().BeFalse();

        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, "identity.permissions-change");
        using (var put = await app.SendAsync(
                   HttpMethod.Put, $"/api/v1/identity/guests/{guest.UserId}/permissions", new { permissions = TrainingAndTv }))
        {
            put.StatusCode.Should().Be(HttpStatusCode.OK, await put.Content.ReadAsStringAsync(Ct));
        }

        await GuestSeed.WaitForIdentityOutboxAsync(app.Database);
        (await FollowsDefaultAsync(app, guest.UserId)).Should().BeTrue("o módulo da TV acrescentado depois tem o mesmo efeito do convite");
        (await VisibleTvsAsync(app, guest.Login.AccessToken)).Should().Equal(defaultTvId);
    }

    [Fact]
    public async Task AccountThatExistedBeforeTheMigration_KeepsTheDefaultTv_WithoutMembershipOrMark()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { SeedBeforeGrants = SeedTheOldAccountAsync });
        var defaultTvId = await DefaultTvIdAsync(app);

        (await PredatesModuleInvitesAsync(app, OldId)).Should().BeTrue("a migration marca toda conta que já existia");
        (await FollowsDefaultAsync(app, OldId)).Should().BeFalse();
        await using (var db = app.Db())
        {
            (await db.TvMembers.AnyAsync(m => m.UserId == OldId, Ct)).Should().BeFalse();
        }

        var login = await LoginOldAccountAsync(app);
        (await VisibleTvsAsync(app, login.AccessToken)).Should().Equal(defaultTvId);
        using var state = await app.GetAsync($"/api/v1/tv/state?tvId={defaultTvId}", bearer: login.AccessToken);
        ReachedTheTv(state.StatusCode).Should().BeTrue();

        // A conta criada depois da migration não herda a marca.
        var newcomer = await app.NewGuestAsync("Depois", null, 74);
        (await PredatesModuleInvitesAsync(app, newcomer.UserId)).Should().BeFalse();
    }

    private static async Task SeedTheOldAccountAsync(IdentityDbContext context)
    {
        var hash = new PasswordService().Hash(OldPassword);
        var createdAt = new DateTimeOffset(2026, 10, 19, 10, 0, 0, TimeSpan.Zero);
        await context.Database.ExecuteSqlAsync(
            $"INSERT INTO identity.users (id, email, display_name, password_hash, created_at, failed_login_count, role, disabled_at) VALUES ({OldId}, {OldEmail}, {"Antiga"}, {hash}, {createdAt}, 0, 'guest', NULL)",
            Ct);
    }

    private static async Task<LoggedIn> LoginOldAccountAsync(TvApp app)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/login")
        {
            Content = JsonContent.Create(new { email = OldEmail, password = OldPassword }),
        };
        request.Headers.Add(IdentityApp.ClientHeader, "web");
        using var response = await app.Client.SendAsync(request, Ct);
        return await GuestSeed.ReadLoginAsync(response);
    }
}
