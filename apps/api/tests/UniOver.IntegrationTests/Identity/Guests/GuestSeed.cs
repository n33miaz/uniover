using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.IntegrationTests.Identity.Guests;

/// <summary>
/// Atalhos dos testes de convidado: grava um convite direto no banco (com o segredo conhecido do teste) e fala com a
/// rota de aceite pelo HTTP de verdade. Os e-mails e senhas são fictícios e vivem só aqui.
/// </summary>
internal static class GuestSeed
{
    public const string AcceptRoute = "/api/v1/identity/guest-invites/accept";

    public static string NewPassword() => "convidado-" + Guid.NewGuid().ToString("N");

    public static string NewEmail() => "convidado-" + Guid.NewGuid().ToString("N")[..8] + "@uniover.test";

    /// <summary>Cria um convite pendente em nome do dono semeado e devolve o id e o segredo do link.</summary>
    public static async Task<(Guid InviteId, string Token)> InsertInviteAsync(
        TestDatabase database,
        DateTimeOffset now,
        string label = "Convidada",
        TimeSpan? validFor = null,
        IReadOnlyCollection<string>? permissions = null)
    {
        ArgumentNullException.ThrowIfNull(database);

        await using var db = IdentityApp.CreateContext(database.OwnerConnection);
        var owner = await db.Users.SingleAsync(u => u.Role == AccountRoles.Owner, TestContext.Current.CancellationToken);
        var (secret, hash) = SecretTokens.Generate();
        var invite = GuestInvite.Create(owner.Id, label, hash, now, validFor ?? TimeSpan.FromHours(48), permissions);
        db.GuestInvites.Add(invite);
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        return (invite.Id, secret);
    }

    public static async Task<HttpResponseMessage> AcceptAsync(
        HttpClient client, string? token, string? email, string? password, bool clientHeader = true, string? forwardedFor = null, TestDevice? device = null)
    {
        ArgumentNullException.ThrowIfNull(client);

        using var request = new HttpRequestMessage(HttpMethod.Post, AcceptRoute)
        {
            Content = JsonContent.Create(new { token, email, password }),
        };
        if (clientHeader)
        {
            request.Headers.Add(IdentityApp.ClientHeader, "web");
        }

        if (forwardedFor is not null)
        {
            request.Headers.Add("X-Forwarded-For", forwardedFor);
        }

        foreach (var (name, value) in device?.KeyHeaders() ?? new Dictionary<string, string>())
        {
            request.Headers.Add(name, value);
        }

        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    public static async Task<LoggedIn> ReadLoginAsync(HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);

        response.EnsureSuccessStatusCode();
        var body = await IdentityApp.JsonAsync(response);
        var cookie = IdentityApp.Cookies(response).Single(c => c.Name == "uo_rt");
        return new LoggedIn(body.GetProperty("accessToken").GetString()!, cookie.Value, cookie, body);
    }

    /// <summary>Aceita um convite novo e devolve a sessão da pessoa e as credenciais que ela escolheu.</summary>
    public static async Task<GuestSession> CreateGuestAsync(
        HttpClient client,
        TestDatabase database,
        DateTimeOffset now,
        string label = "Alice",
        IReadOnlyCollection<string>? permissions = null)
    {
        var (_, token) = await InsertInviteAsync(database, now, label, permissions: permissions);
        var email = NewEmail();
        var password = NewPassword();
        using var response = await AcceptAsync(client, token, email, password);
        var login = await ReadLoginAsync(response);

        await using var db = IdentityApp.CreateContext(database.OwnerConnection);
        var user = await db.Users.SingleAsync(u => u.Email == email, TestContext.Current.CancellationToken);
        return new GuestSession(user.Id, email, password, login);
    }
}

internal sealed record GuestSession(Guid UserId, string Email, string Password, LoggedIn Login);
