using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;

namespace UniOver.IntegrationTests.Identity.QrLogin;

/// <summary>Quem tem passkey confirma a entrada do computador com ela (a confirmação da ação, gasta a cada entrada).</summary>
[Collection(PostgresGroup.Name)]
public sealed class QrLoginPasskeyTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(PasskeyApp App, LoggedIn Owner, VirtualAuthenticator Authenticator)> StartOwnerAsync()
    {
        var app = await PasskeyApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var authenticator = new VirtualAuthenticator();
        await app.RegisterAsync(owner, authenticator);
        return (app, owner, authenticator);
    }

    private static async Task<HttpResponseMessage> PostAsync(PasskeyApp app, string url, object? body, string? bearer = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        request.Headers.Add(IdentityApp.ClientHeader, "web");
        if (bearer is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        }

        return await app.Client.SendAsync(request, Ct);
    }

    private static async Task<(string Code, string Secret)> StartAsync(PasskeyApp app)
    {
        using var response = await PostAsync(app, QrRoutes.Start, null);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await IdentityApp.JsonAsync(response);
        return (body.GetProperty("code").GetString()!, body.GetProperty("pollSecret").GetString()!);
    }

    [Fact]
    public async Task Approve_WithAPasskey_NeedsTheConfirmationOfTheAction_AndSpendsIt()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var (code, secret) = await StartAsync(app);

        using var info = await PostAsync(app, QrRoutes.Info, new { code }, owner.AccessToken);
        (await IdentityApp.JsonAsync(info)).GetProperty("verification").GetString().Should().Be("passkey");

        // Sem a confirmação: o mesmo 403 de "precisa da passkey" que as outras rotas devolvem, e nada foi aprovado.
        using var refused = await PostAsync(app, QrRoutes.Approve, new { code }, owner.AccessToken);
        refused.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var problem = await IdentityApp.JsonAsync(refused);
        problem.GetProperty("code").GetString().Should().Be("step_up_required");
        problem.GetProperty("action").GetString().Should().Be("identity.qr-login-approve");
        problem.GetProperty("type").GetString().Should().EndWith("/step-up-required");
        await ExpectStatusAsync(app, secret, "pending");

        // A confirmação de OUTRA ação não serve.
        using var other = await app.ConfirmAsync(owner, authenticator, PasskeyApp.DangerousAction);
        other.StatusCode.Should().Be(HttpStatusCode.OK);
        using var stillRefused = await PostAsync(app, QrRoutes.Approve, new { code }, owner.AccessToken);
        stillRefused.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.QrLoginApprove);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        using var approved = await PostAsync(app, QrRoutes.Approve, new { code }, owner.AccessToken);
        approved.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Cada entrada pede um toque novo: a confirmação foi gasta.
        var (nextCode, nextSecret) = await StartAsync(app);
        using var again = await PostAsync(app, QrRoutes.Approve, new { code = nextCode }, owner.AccessToken);
        again.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await ExpectStatusAsync(app, nextSecret, "pending");

        await ExpectStatusAsync(app, secret, "approved");
    }

    [Fact]
    public async Task Approve_WithAPasskey_IgnoresAPasswordInTheBody_AndOldSessionsStillNeedOnlyThePasskey()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        app.Time.Advance(TimeSpan.FromMinutes(7));
        var (code, secret) = await StartAsync(app);

        // A senha certa no corpo NÃO substitui a passkey: quem tem passkey nunca cai no caminho mais fraco.
        using var withPassword = await PostAsync(app, QrRoutes.Approve, new { code, password = app.OwnerPassword }, owner.AccessToken);
        withPassword.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await IdentityApp.JsonAsync(withPassword)).GetProperty("code").GetString().Should().Be("step_up_required");
        await ExpectStatusAsync(app, secret, "pending");
    }

    [Fact]
    public async Task ThePcSession_GetsNoExtraPower_TheStepUpIsStillRequiredThere()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var (code, secret) = await StartAsync(app);
        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.QrLoginApprove);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);
        (await PostAsync(app, QrRoutes.Approve, new { code }, owner.AccessToken)).Dispose();

        using var poll = await PostAsync(app, QrRoutes.Poll, new { secret });
        var pc = new LoggedIn(
            (await IdentityApp.JsonAsync(poll)).GetProperty("accessToken").GetString()!, string.Empty, null!, default);

        // A confirmação do celular não vale na sessão do computador: ação perigosa lá pede a passkey de novo.
        using var dangerous = await app.CallDangerousAsync(pc);
        dangerous.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await IdentityApp.JsonAsync(dangerous)).GetProperty("code").GetString().Should().Be("step_up_required");

        await using var db = app.Db();
        (await db.StepUpConfirmations.CountAsync(c => c.Action == StepUpActions.QrLoginApprove, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task OneConfirmation_ApprovesOnlyOneOfSeveralSimultaneousEntries()
    {
        var (app, owner, authenticator) = await StartOwnerAsync();
        await using var appScope = app;
        using var authScope = authenticator;
        var requests = new List<(string Code, string Secret)>();
        for (var i = 0; i < 6; i++)
        {
            requests.Add(await StartAsync(app));
        }

        using var confirm = await app.ConfirmAsync(owner, authenticator, StepUpActions.QrLoginApprove);
        confirm.StatusCode.Should().Be(HttpStatusCode.OK);

        var statuses = await Task.WhenAll(requests.Select(async r =>
        {
            using var response = await PostAsync(app, QrRoutes.Approve, new { code = r.Code }, owner.AccessToken);
            return response.StatusCode;
        }));

        statuses.Count(s => s == HttpStatusCode.NoContent).Should().Be(1, "um toque libera uma entrada só");
        statuses.Where(s => s != HttpStatusCode.NoContent).Should().OnlyContain(s => s == HttpStatusCode.Forbidden);

        var approved = 0;
        foreach (var (_, secret) in requests)
        {
            using var poll = await PostAsync(app, QrRoutes.Poll, new { secret });
            var status = (await IdentityApp.JsonAsync(poll)).GetProperty("status").GetString();
            approved += status == "approved" ? 1 : 0;
            status.Should().BeOneOf("approved", "pending");
        }

        approved.Should().Be(1);
    }

    private static async Task ExpectStatusAsync(PasskeyApp app, string secret, string expected)
    {
        using var poll = await PostAsync(app, QrRoutes.Poll, new { secret });
        poll.StatusCode.Should().Be(HttpStatusCode.OK);
        (await IdentityApp.JsonAsync(poll)).GetProperty("status").GetString().Should().Be(expected);
    }
}
